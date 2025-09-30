"""class to modify the layout elements based on some rules"""

import asyncio
import logging
import re
import unicodedata
from typing import Literal, Pattern, Type
from pydantic import BaseModel, Field
import wordninja
import py3langid
from ..resources import LANG_TO_PATH
from .config import EnrichmentConfig
from .utils import (
    get_lines,
    count_start_chars,
    get_position_page_element,
    get_next_candidate_position,
    columns_matching,
)
from ..utils import is_unreadable
from ..model.gemini import GeminiModel
from ..schemas import (
    PLayout,
    WLayout,
    LLayout,
    Paragraph,
    Word,
    Text,
    List,
    Header,
    Footer,
    TableContent,
    ElementType,
    Extractor,
    Extra,
    AutoElement,
    AutoPlayoutElement,
    CONTENT_CLASS_TYPES,
)

logger = logging.getLogger(__name__)

# maximum number of characters to detect the language with py3langid
MAX_DETECT_LANG_LENGTH: int = 100000
# minimum number of consecutive small words to consider them as exploded
MIN_WORDS_TO_MERGE: int = 3
# maximum number of characters to consider as part of an exploded word
MAX_EXPLODED_LENGTH: int = 3
# Regex to exclude words from being considered as merged word that we want to split
NOT_MERGED_WORDS_REGEX = re.compile(r"[^\w\d\-']")


class LayoutModifier(BaseModel):
    """Modify the layout elements based on some rules

    Attributes
    ----------
    enrichment_config: EnrichmentConfig
        Enrichment configuration

    Methods
    -------
    update_layout_type_list(layout: PLayout) -> None
        Update the type of each layout element from text to list if a list is detected
    update_layout_type_header(layout: PLayout) -> None
        Update the type of each layout element from text to list if a list is detected
    anchoring_vertical_paragraphs(layout: PLayout) -> None
        Reorder a vertical paragraphs in the layout based on the vertical_paragraph_anchor
    merge_exploded_words(layout: PLayout) -> None
        Merge exploded words in the layout
    split_long_words(layout: PLayout) -> None
        Split long words in the layout using wordninja
    normalize_layout_content(layout: PLayout | WLayout | LLayout) -> None
        Normalize content of the layout elements
    remove_extras(layout: PLayout) -> None
        Remove extra elements from the layout based on regex
    join_text_overlapping_pages(layout: PLayout) -> None
        Join text elements that are overlapping on different pages
    join_list_overlapping_pages(layout: PLayout) -> None
        Join list elements that are overlapping on different pages
    join_table_overlapping_pages(layout: PLayout) -> None
        Join table elements that are overlapping on different pages
    apply_enrichment(layout: PLayout) -> None
        Apply all enrichment methods to the layout, in default order,
        weather they are enabled in the config or not
    parse_images(layout: PLayout, model: GeminiModel) -> dict[str, str]
        Parse images in the layout using gemini
    set_images_content(layout: PLayout, res: dict[str, str]) -> None
        Set the content of images in the layout based on the responses from the model
    """

    enrichment_config: EnrichmentConfig = Field(
        description="Enrichment configuration",
        default_factory=EnrichmentConfig,
    )

    def _update_class_in_layout(
        self,
        layout: PLayout,
        old_element: AutoPlayoutElement,
        new_class: Type[List | Header | Footer],
    ) -> None:
        """Update the class of an element in the layout"""
        new_element = new_class.create(
            x0=old_element.x0,
            y0=old_element.y0,
            x1=old_element.x1,
            y1=old_element.y1,
            content=old_element.content,
            metadata=old_element.metadata,
        )
        if new_element is not None:
            layout.replace_element(old_element, new_element)
        return layout

    def _detect_list(self, content: list[Word]) -> bool:
        """Detect if a list is present in the content"""
        lines = get_lines(content)
        start_chars = count_start_chars(
            lines,
            self.enrichment_config.list_starters,
            self.enrichment_config.regex_num_starter,
        )
        if len(start_chars["dash"]) > 1 or len(start_chars["number"]) > 1:
            return True
        return False

    def update_layout_type_list(self, layout: PLayout) -> None:
        """Update the type of each layout element from text to list if a list is detected"""
        for element in layout.root:
            if self.enrichment_config.extractor_list_update_policy == "all" or (
                self.enrichment_config.extractor_list_update_policy == "yolo"
                and element.extractor == Extractor.YOLO
            ):
                if element.type == ElementType.TEXT and self._detect_list(
                    element.content
                ):
                    # update the class of the element to List
                    self._update_class_in_layout(layout, element, List)

    def split_list_content(self, layout: PLayout) -> None:
        """detect list indicators and set item and desc index in metadata"""
        for element in layout.root:
            if element.type == ElementType.LIST:
                lines = get_lines(element.content)
                start_chars = count_start_chars(
                    lines,
                    self.enrichment_config.list_starters,
                    self.enrichment_config.regex_num_starter,
                )
                split_index = []
                if (
                    self.enrichment_config.list_starters_policy in ["all", "dash"]
                    and len(start_chars["dash"]) > 1
                ):
                    split_index = start_chars["dash"]
                elif (
                    self.enrichment_config.list_starters_policy in ["all", "number"]
                    and len(start_chars["number"]) > 1
                ):
                    split_index = start_chars["number"]
                element.metadata["item_idx"] = split_index
                element.metadata["desc_idx"] = start_chars["colon"]

    def _detect_header(
        self, element: Paragraph, page_elements: list[AutoElement]
    ) -> bool:
        """Detect if the element is a header or a footer"""
        for page_element in page_elements:
            if page_element.type not in [
                ElementType.HEADER,
                ElementType.FOOTER,
                ElementType.EXTRA,
            ]:
                return False
            # there are only Extra elements between the edge of the page and the element
            if page_element == element:
                return True
        return False

    def update_layout_type_header(self, layout: PLayout) -> None:
        """Update the type of each extra element to header / footer if detected as such"""
        for element in layout.root:
            if element.type == ElementType.EXTRA:
                # check if the element is a header
                if self._detect_header(
                    element, layout.get_elements_by_page(element.page)
                ):
                    # update the class of the element to Header
                    self._update_class_in_layout(layout, element, Header)
                # detect if the element is a footer
                if self._detect_header(
                    element, layout.get_elements_by_page(element.page)[::-1]
                ):
                    if isinstance(element, Header):
                        # if element is both header and footer, check y0
                        if element.y0 > 0.5:
                            # update the class of the element to Footer
                            self._update_class_in_layout(layout, element, Footer)
                    else:
                        # update the class of the element to Footer
                        self._update_class_in_layout(layout, element, Footer)

    def anchoring_vertical_paragraphs(self, layout: PLayout) -> None:
        """Anchoring a vertical element in the layout based on the vertical_paragraph_anchor"""
        # get all the vertical elements
        vertical_elements: list[AutoPlayoutElement] = []
        for element in layout.root:
            if isinstance(element, Paragraph) and element.is_vertical:
                vertical_elements.append(element)

        # reorder the vertical elements based on the vertical_paragraph_anchor
        for vertical_element in vertical_elements:
            if self.enrichment_config.vertical_paragraph_anchor == "top":
                insert_position = get_position_page_element(
                    layout, vertical_element.page, "first"
                )
                # remove vertical_element then insert at the beginning of the page
                layout.root.remove(vertical_element)
                layout.root.insert(insert_position, vertical_element)
            elif self.enrichment_config.vertical_paragraph_anchor == "bottom":
                insert_position = get_position_page_element(
                    layout, vertical_element.page, "last"
                )
                # insert after the last element on the page then remove the first occurrence
                layout.root.insert(insert_position + 1, vertical_element)
                layout.root.remove(
                    vertical_element
                )  # delete first occurrence of vertical_element
            elif self.enrichment_config.vertical_paragraph_anchor == "inplace":
                insert_position = None
                offset = 0  # offset to adjust the position after removing the vertical element
                # get the first element with a higher y0 value which is not the vertical element
                for position, element in enumerate(layout.root):
                    if element.page != vertical_element.page:
                        continue
                    if element == vertical_element:
                        offset = 1
                        continue
                    if element.y0 > vertical_element.y0:
                        insert_position = position - offset if position > 0 else 0
                        break
                if insert_position is not None:
                    # remove vertical_element then insert at correct position
                    layout.root.remove(vertical_element)
                    layout.root.insert(insert_position, vertical_element)

    def _set_lang(self, layout_str: str) -> None:
        """Detect the language of the layout using py3langid
        and Set the language for wordninja"""
        # detect the language of the layout if config is auto
        if self.enrichment_config.document_language == "auto":
            # use only the first MAX_DETECT_LANG_LENGTH characters to detect the language
            if len(layout_str) > MAX_DETECT_LANG_LENGTH:
                layout_str = layout_str[:MAX_DETECT_LANG_LENGTH]
            lang = py3langid.classify(layout_str)[0]
        else:
            lang = self.enrichment_config.document_language
        if lang in LANG_TO_PATH:
            wordninja.DEFAULT_LANGUAGE_MODEL = wordninja.LanguageModel(
                str(LANG_TO_PATH[lang])
            )

    def _merge_words(self, words: list[Word]) -> Word | None:
        """Merge words into a single word then use wordninja to split it"""
        merged_word = "".join(word.content for word in words)
        content = " ".join(wordninja.split(merged_word))
        if content:
            return Word.create(
                content=content,
                x0=min(word.x0 for word in words),
                x1=max(word.x1 for word in words),
                y0=min(word.y0 for word in words),
                y1=max(word.y1 for word in words),
                metadata=words[0].metadata,
            )
        return None

    def merge_exploded_words(self, layout: PLayout) -> None:
        """Merge exploded words in the layout"""
        lang_is_set = False
        for element in layout.root:
            if isinstance(element, Paragraph):
                if (
                    self.enrichment_config.word_merge_policy == "vertical"
                    and not element.is_vertical
                ):
                    continue
                new_content: list[Word | None] = []
                buffer: list[Word] = []
                # None is added to handle the remaining buffer at the end
                for word in element.content + [None]:
                    if (
                        word is not None
                        and 1 <= len(word.content) <= MAX_EXPLODED_LENGTH
                    ):
                        buffer.append(word)
                    else:
                        # Merge buffered words if there are more than 3 consecutive words
                        # And if the number of 1-char words is more than half of the buffer
                        if (
                            len(buffer) > MIN_WORDS_TO_MERGE
                            and sum(1 for w in buffer if len(w.content) == 1)
                            > len(buffer) // 2
                        ):
                            if not lang_is_set:
                                self._set_lang(layout.to_str())
                                lang_is_set = True
                            new_content.append(self._merge_words(buffer))
                        else:
                            new_content.extend(buffer)
                        buffer = []
                        if word is not None:
                            new_content.append(word)
                element.content = list(filter(None, new_content))
        layout.filter_empty_elements()

    def split_long_words(self, layout: PLayout) -> None:
        """Split long words in the layout using wordninja"""
        lang_is_set = False
        for element in layout.root:
            if isinstance(element, Paragraph):
                for word in element.content:
                    if (
                        len(word.content) > self.enrichment_config.max_word_length
                        and not NOT_MERGED_WORDS_REGEX.search(word.content)
                    ):
                        if not lang_is_set:
                            self._set_lang(layout.to_str())
                            lang_is_set = True
                        word.content = " ".join(wordninja.split(word.content))
        layout.filter_empty_elements()

    def _normalize_text(self, content: str) -> str:
        return unicodedata.normalize(self.enrichment_config.normalize_form, content)

    def normalize_layout_content(self, layout: PLayout | WLayout | LLayout) -> None:
        """Normalize content of the layout elements"""
        if self.enrichment_config.normalize_form == "no":
            return
        for element in layout.root:
            if not isinstance(element, CONTENT_CLASS_TYPES):
                continue
            if element.type == ElementType.WORD:
                element.content = self._normalize_text(element.content)
            elif element.type == ElementType.TABLE_CONTENT:
                element.content = [
                    [self._normalize_text(word) for word in row]
                    for row in element.content
                ]
            else:
                for word in element.content:
                    word.content = self._normalize_text(word.content)

    def clean_word(self, word: str) -> tuple[str, int, int]:
        """Clean a word by stripping its content and count changes"""
        cid_count = 0
        unreadable_count = 0

        if self.enrichment_config.clean_cid_error:
            word, cid_count = re.subn(r"(\(cid\:\d+\))", "", word)

        if self.enrichment_config.clean_unreadable_chars:
            unreadable_count = sum(1 for char in word if is_unreadable(char))
            word = "".join(char for char in word if not is_unreadable(char))

        return word.strip(), cid_count, unreadable_count

    def clean_layout_content(self, layout: PLayout | LLayout | WLayout) -> None:
        """Clean content of the layout elements and report counts"""
        total_cid_count = 0
        total_unreadable_count = 0

        for element in layout.root:
            if not isinstance(element, CONTENT_CLASS_TYPES):
                continue

            if element.type == ElementType.WORD:
                cleaned, cid_count, unreadable_count = self.clean_word(element.content)
                element.content = cleaned
            elif element.type == ElementType.TABLE_CONTENT:
                new_content = []
                for row in element.content:
                    new_row = []
                    for word in row:
                        cleaned, cid_count, unreadable_count = self.clean_word(word)
                        new_row.append(cleaned)
                        total_cid_count += cid_count
                        total_unreadable_count += unreadable_count
                    new_content.append(new_row)
                element.content = new_content
            else:
                for word in element.content:
                    cleaned, cid_count, unreadable_count = self.clean_word(word.content)
                    word.content = cleaned
                    total_cid_count += cid_count
                    total_unreadable_count += unreadable_count
                element.content = [
                    word for word in element.content if word.content.strip()
                ]  # Remove empty words

            # Add WORD-level counts here too
            if element.type == ElementType.WORD:
                total_cid_count += cid_count
                total_unreadable_count += unreadable_count

        if total_cid_count or total_unreadable_count:
            logger.info(
                "Removed %s CID errors and %s unreadable characters.",
                total_cid_count,
                total_unreadable_count,
            )
        layout.filter_empty_elements()

    def _match_content(self, content: str, remove_pattern: list[Pattern[str]]) -> bool:
        """Match extra content with regex"""
        for regex in remove_pattern:
            if regex.match(content):
                return True
        return False

    def remove_extras(
        self,
        layout: PLayout,
        remove_extra: Literal["all", "header", "footer", "none"] | None = None,
        remove_pattern: list[Pattern[str]] | None = None,
    ) -> None:
        """Remove extra elements from the layout based on regex
        if remove_extra or remove_pattern is None, the value from the config is used
        (e.g. remove_extra=enrichment_config.remove_extra
        remove_pattern=enrichment_config.remove_extra_pattern)
        """
        if remove_extra is None:
            remove_extra = self.enrichment_config.remove_extra
        if remove_pattern is None:
            remove_pattern = self.enrichment_config.remove_extra_pattern
        if remove_extra == "none" or not remove_pattern:
            return
        index_to_remove: list[int] = []
        # Remove extra based on regex
        for n, element in enumerate(layout.root):
            if not isinstance(element, Paragraph):
                continue
            if (
                (remove_extra == "all" and isinstance(element, Extra))
                or (remove_extra == "header" and element.type == ElementType.HEADER)
                or (remove_extra == "footer" and element.type == ElementType.FOOTER)
            ):
                if self._match_content(element.to_str(), remove_pattern):
                    index_to_remove.append(n)

        # Remove elements in reverse order to avoid index issues
        for n in index_to_remove[::-1]:
            layout.root.pop(n)

    def join_text_overlapping_pages(self, layout: PLayout) -> None:
        """Join text elements that are overlapping on different pages"""
        remove_index: list[int] = []
        for current_elem, element in enumerate(layout.root):
            if current_elem in remove_index:
                continue
            if (
                element.page is not None
                and isinstance(element, Text)
                and not element.inferred
            ):
                next_elem_pos = get_next_candidate_position(current_elem, layout)
                if next_elem_pos is None:
                    continue
                next_elem = layout.root[next_elem_pos]
                if (
                    # next_elem is same type as current element
                    isinstance(next_elem, Text)
                    # next_elem is on the next page
                    and next_elem.page == element.page + 1
                    # first element does not end with a dot
                    and element.content
                    and not element.content[-1].content.strip().endswith(".")
                    # second element does not start with an uppercase letter
                    and next_elem.content
                    and next_elem.content[0].content
                    and not next_elem.content[0].content[0].isupper()
                ):
                    element.merge_element(next_elem)
                    remove_index.append(next_elem_pos)
        # Remove elements in reverse order to avoid index issues
        for n in remove_index[::-1]:
            layout.root.pop(n)

    def join_list_overlapping_pages(self, layout: PLayout) -> None:
        """Join text elements that are overlapping on different pages"""
        remove_index: list[int] = []
        for current_elem, element in enumerate(layout.root):
            if current_elem in remove_index:
                continue
            if element.page is not None and isinstance(element, List):
                next_elem_pos = get_next_candidate_position(current_elem, layout)
                if next_elem_pos is None:
                    continue
                next_elem = layout.root[next_elem_pos]
                if (
                    # next_elem is same type as current element
                    isinstance(next_elem, List)
                    # next_elem is on the next page
                    and next_elem.page == element.page + 1
                ):
                    # second element starts with a list starter
                    if "item_idx" in next_elem.metadata:
                        if 0 in next_elem.metadata["item_idx"]:
                            element.merge_element(next_elem)
                            remove_index.append(next_elem_pos)
                    elif next_elem.content and next_elem.content[0].content.startswith(
                        tuple(self.enrichment_config.list_starters)
                    ):
                        element.merge_element(next_elem)
                        remove_index.append(next_elem_pos)
                    elif self.enrichment_config.regex_num_starter.match(
                        next_elem.content[0].content
                    ):
                        element.merge_element(next_elem)
                        remove_index.append(next_elem_pos)
        # Remove elements in reverse order to avoid index issues
        for n in remove_index[::-1]:
            layout.root.pop(n)

    def join_table_overlapping_pages(self, layout: PLayout) -> None:
        """Join table elements that are overlapping on different pages"""
        remove_index: list[int] = []
        for current_elem, element in enumerate(layout.root):
            if current_elem in remove_index:
                continue
            if element.page is not None and isinstance(element, TableContent):
                next_elem_pos = get_next_candidate_position(current_elem, layout)
                if next_elem_pos is None:
                    continue
                next_elem = layout.root[next_elem_pos]
                if (
                    # next_elem is same type as current element
                    isinstance(next_elem, TableContent)
                    # next_elem is on the next page
                    and next_elem.page == element.page + 1
                    # they have the same number of columns
                    and element.nb_columns == next_elem.nb_columns
                    # first row of both tables are different
                    and element.content[0] != next_elem.content[0]
                    # first row of the second table is not a header
                    and not next_elem.first_row_is_header
                    # Columns boundaries are matching
                    and columns_matching(
                        element,
                        next_elem,
                        self.enrichment_config.column_boundaries_tolerance,
                    )
                ):
                    element.merge_element(next_elem)
                    remove_index.append(next_elem_pos)
        # Remove elements in reverse order to avoid index issues
        for n in remove_index[::-1]:
            layout.root.pop(n)

    async def parse_images(self, layout: PLayout, model: GeminiModel) -> dict[str, str]:
        """Parse images in the layout using gemini
        return a dictionary of responses by image ID"""
        tasks = {
            image.id: asyncio.create_task(
                model.transcript_image(image.metadata["base64"])
            )
            for image in layout.images
        }
        results = await asyncio.gather(*tasks.values())
        # Combine results with image IDs
        responses_by_id = {
            image_id: result for image_id, result in zip(tasks.keys(), results)
        }
        return responses_by_id

    def set_images_content(self, layout: PLayout, res: dict[str, str]) -> None:
        """Set the content of images in the layout based on the responses from the model"""
        if res:
            for image in layout.images:
                if image.id in res:
                    if img_content := Word.create(
                        content=res[image.id],
                        x0=image.x0,
                        y0=image.y0,
                        x1=image.x1,
                        y1=image.y1,
                        page=image.page,
                    ):
                        image.content = [img_content]

    def apply_enrichment(self, layout: PLayout) -> None:
        """Apply all enrichment methods to the layout, in default order,
        weather they are enabled in the config or not"""
        if self.enrichment_config.normalize_form != "no":
            self.normalize_layout_content(layout)
        if (
            self.enrichment_config.clean_cid_error
            or self.enrichment_config.clean_unreadable_chars
        ):
            self.clean_layout_content(layout)
        if self.enrichment_config.extractor_list_update_policy != "none":
            self.update_layout_type_list(layout)
        if self.enrichment_config.list_starters_policy != "none":
            self.split_list_content(layout)
        if self.enrichment_config.vertical_paragraph_anchor != "no":
            self.anchoring_vertical_paragraphs(layout)
        if self.enrichment_config.word_merge_policy != "none":
            self.merge_exploded_words(layout)
        if self.enrichment_config.split_long_words is not False:
            self.split_long_words(layout)
        self.update_layout_type_header(layout)
        if self.enrichment_config.remove_extra is not None:
            self.remove_extras(layout)
        if self.enrichment_config.join_consecutive_text is not False:
            self.join_text_overlapping_pages(layout)
        if self.enrichment_config.join_consecutive_list is not False:
            self.join_list_overlapping_pages(layout)
        if self.enrichment_config.join_consecutive_table is not False:
            self.join_table_overlapping_pages(layout)
        layout.filter_empty_elements()
