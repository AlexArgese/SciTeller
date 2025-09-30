"""Utils for structuration module"""

import logging
from typing import Pattern, Sequence
from ..schemas import (
    Layout,
    Paragraph,
    Text,
    Line,
    Word,
    VisualElement,
    PLayout,
    WLayout,
    LLayout,
    AutoElement,
    AutoPlayoutElement,
    ElementType,
)
from ..utils import is_bbox_within, match_interval
from ..extract.utils import get_word_list

logger = logging.getLogger(__name__)


def check_word_in_reading_order(element: Paragraph, word: Word, n_element: int) -> None:
    """check if word is in reading order of the paragraph
    log a warning if not"""
    if (
        element.content
        and element.content[-1].y0 > word.y1
        and not word.metadata.get("vertical", None)
    ):
        logger.warning(
            "Word not in reading order (word : %s) "
            "In Paragraph x0 %s, x1 %s, y0 %s, y1 %s, page: %s, idx : %s\n"
            "Might be because of a Paragraph including multiple columns, "
            "or an Ocr order error "
            "Try to use build_lines_method = 'bbox'",
            word.content,
            element.x0,
            element.x1,
            element.y0,
            element.y1,
            element.page,
            n_element,
        )


def append_word_to_paragraph(
    layout_page: Sequence[AutoPlayoutElement],
    word: Word,
    threshold_word: float,
) -> AutoPlayoutElement | None:
    """Append word to paragraph if word bbox is within paragraph bbox
    return paragraph if word is appended else None"""
    for n_element, element in enumerate(layout_page):
        if isinstance(element, Paragraph):
            if is_bbox_within(word, element, threshold_word):
                check_word_in_reading_order(element, word, n_element)
                element.content.append(word)
                return element
    return None


def no_visual_elements_between_elements(
    element: AutoElement,
    next_element: AutoElement,
    visual_elements: list[VisualElement],
) -> bool:
    """Check if there is no visual elements between two elements"""
    return not any(
        match_interval((element.x0, element.x1), (ve.x0, ve.x1))
        and match_interval((next_element.x0, next_element.x1), (ve.x0, ve.x1))
        and element.y1 < ve.y0 < next_element.y0
        for ve in visual_elements
    )


def no_columns_between_elements(
    element: AutoElement,
    next_element: AutoElement,
    columns: list[tuple[float, float, float]],
):
    """Check if there is no columns between two elements"""
    return not any(
        match_interval((element.y0, element.y1), (col[1], col[2]))
        and match_interval((next_element.y0, next_element.y1), (col[1], col[2]))
        and element.x1 < col[0] < next_element.x0
        for col in columns
    )


def append_word_with_prev_word(
    columns: list[tuple[float, float, float]],
    line: Sequence[Word],
    word: Word,
    n_word: int,
    prev_element: AutoPlayoutElement | None,
) -> AutoPlayoutElement | None:
    """Append word next to previous word if there is no columns between them"""
    if prev_element is None:
        return None
    if no_columns_between_elements(line[n_word - 1], word, columns):
        if isinstance(prev_element, Paragraph):
            prev_element.content.append(word)
        return prev_element
    return None


def append_word_anticipating_next_words(
    layout_page: Sequence[AutoPlayoutElement],
    columns: list[tuple[float, float, float]],
    line: Sequence[Word],
    word: Word,
    n_word: int,
    threshold_word: float,
    look_for_chapters: bool,
    regex_chapter: list[Pattern[str]],
) -> AutoPlayoutElement | None:
    """Append word to paragraph if any next words of the line will be in a paragraph
    for each next_word in line:
        check if next_word is in a paragraph
        check if there is no columns between word and next_word
                Or the word is a chapter and the option look_for_chapters is True
        append word to the paragraph
    """
    for next_word in line[n_word:]:
        for element in layout_page:
            if isinstance(element, Paragraph):
                if is_bbox_within(next_word, element, threshold_word):
                    if no_columns_between_elements(word, next_word, columns) or (
                        look_for_chapters
                        and any(regex.match(word.content) for regex in regex_chapter)
                    ):
                        element.content.append(word)
                        return element
    return None


def update_paragraph_bbox(paragraph: Text) -> None:
    """Update paragraph bbox with content"""
    paragraph.x0 = min(word.x0 for word in paragraph.content)
    paragraph.x1 = max(word.x1 for word in paragraph.content)
    paragraph.y0 = min(word.y0 for word in paragraph.content)
    paragraph.y1 = max(word.y1 for word in paragraph.content)


def merge_inferred_paragraphs(
    layout: PLayout, visual_elements: list[VisualElement]
) -> PLayout:
    """Merge following inferred paragraphs with same page and matching x interval"""
    for elem_position, element in enumerate(layout.root):
        if isinstance(element, Paragraph) and element.inferred:
            while (
                len(layout.root) > elem_position + 1
                and layout.root[elem_position + 1].inferred
                and element.page == layout.root[elem_position + 1].page
            ):
                next_element = layout.root[layout.root.index(element) + 1]
                if (
                    isinstance(next_element, Paragraph)
                    and match_interval(
                        (element.x0, element.x1), (next_element.x0, next_element.x1)
                    )
                    and no_visual_elements_between_elements(
                        element, next_element, visual_elements
                    )
                ):
                    element.content += next_element.content
                    layout.root.remove(next_element)
                else:
                    break
    return layout


def insert_paragraphs_in_layout(
    layout: PLayout | None,
    paragraphs: list[Text],
    visual_elements: list[VisualElement],
    columns_by_page: list[list[tuple[float, float, float]]] | None = None,
) -> PLayout:
    """If Layout is None : create layout with paragraphs
    else : insert paragraphs in layout before the first element with a higher y0 on the same page
    and no columns between them"""
    if not layout:
        for paragraph in paragraphs:
            update_paragraph_bbox(paragraph)
        layout = PLayout(paragraphs)
    else:
        for paragraph in paragraphs:
            # update paragraph bbox with content
            update_paragraph_bbox(paragraph)
            # look for the right position to insert the paragraph
            page_last_non_extra_elem = None
            page_last_elem = None
            insert_position = None
            insert_perfect_position = None
            for elem_position, element in enumerate(layout.root):
                columns: list[tuple[float, float, float]] = (
                    columns_by_page[element.page]
                    if columns_by_page is not None
                    and element.page is not None
                    and len(columns_by_page) > element.page
                    else []
                )
                if (
                    element.page == paragraph.page
                    and element.y0 > paragraph.y0
                    and (
                        not columns
                        or no_columns_between_elements(element, paragraph, columns)
                    )
                ):
                    if match_interval(
                        (element.x0, element.x1), (paragraph.x0, paragraph.x1)
                    ):
                        insert_perfect_position = elem_position
                        break
                    if insert_position is None:
                        insert_position = elem_position
                if element.page == paragraph.page:
                    if element.type not in [
                        ElementType.EXTRA,
                        ElementType.HEADER,
                        ElementType.FOOTER,
                    ]:
                        page_last_non_extra_elem = (elem_position, element.y0)
                    page_last_elem = elem_position
                elif (
                    element.page is not None
                    and paragraph.page is not None
                    and element.page > paragraph.page
                ):
                    if page_last_elem is None:
                        # this is the only paragraph of the page, insert it before next page
                        layout.root.insert(elem_position, paragraph)
                    break  # opti
            # insert paragraph if not already inserted
            if paragraph not in layout.root:
                # insert paragraph at the right position (matching x interval)
                if insert_perfect_position is not None:
                    layout.root.insert(insert_perfect_position, paragraph)
                # insert paragraph at the right position
                elif insert_position is not None:
                    layout.root.insert(insert_position, paragraph)
                elif page_last_elem is not None:
                    # insert paragraph at the end of the page before the extra elements if y0 is lower
                    if (
                        page_last_non_extra_elem is not None
                        and paragraph.y0 < page_last_non_extra_elem[1]
                    ):
                        layout.root.insert(page_last_non_extra_elem[0] + 1, paragraph)
                    # insert paragraph at the end of the page
                    else:
                        layout.root.insert(page_last_elem + 1, paragraph)
                # insert paragraph at the end of the layout (default)
                else:
                    layout.root.append(paragraph)
    # merge following inferred paragraphs
    layout = merge_inferred_paragraphs(layout, visual_elements)
    for paragraph in layout.root:
        if paragraph.inferred:
            update_paragraph_bbox(paragraph)
    return layout


def populate_paragraphs(
    layout_ocr: Layout[Line],
    layout: PLayout | None,
    look_for_chapters: bool,
    regex_chapters: list[Pattern[str]],
    columns_by_page: list[list[tuple[float, float, float]]] | None = None,
    threshold_word: float = 0.8,
) -> PLayout:
    """Populate paragraphs with ocr content:
    try in order:
    - append word to paragraph if word bbox is within paragraph bbox
    - append word next to previous word if there is no columns between them
    - append word to paragraph if any next words of the line is in a paragraph
    - create new paragraph from word
    then:
    - insert paragraphs in layout or create layout with paragraphs
    return layout"""
    if layout is None:
        return PLayout([])
    new_paragraphs: list[Text] = []
    page_count = max(layout.page_count if layout else 0, layout_ocr.page_count)
    for page in range(page_count):
        layout_page = layout.get_elements_by_page(page) if layout else []
        ocr_page = layout_ocr.get_elements_by_page(page)
        columns = (
            columns_by_page[page]
            if columns_by_page and len(columns_by_page) > page
            else []
        )
        for line in get_word_list(ocr_page):
            prev_element = None
            for n_word, word in enumerate(line):
                # append word to paragraph if word bbox is within paragraph bbox
                if element := append_word_to_paragraph(
                    layout_page, word, threshold_word
                ):
                    prev_element = element
                # append word next to previous word if there is no columns between them
                elif element := append_word_with_prev_word(
                    columns, line, word, n_word, prev_element
                ):
                    prev_element = element
                # append word to paragraph if any next words of the line is in a paragraph
                # and there are no columns between them
                elif element := append_word_anticipating_next_words(
                    layout_page,
                    columns,
                    line,
                    word,
                    n_word,
                    threshold_word,
                    look_for_chapters,
                    regex_chapters,
                ):
                    prev_element = element
                # create new paragraph from word
                else:
                    new_element = Text.create(
                        x0=word.x0,
                        x1=word.x1,
                        y0=word.y0,
                        y1=word.y1,
                        content=[word],
                        page=page,
                        inferred=True,
                    )
                    if new_element is not None:
                        new_paragraphs.append(new_element)
                        prev_element = new_element

    layout = insert_paragraphs_in_layout(
        layout, new_paragraphs, layout_ocr.get_visual_elements(), columns_by_page
    )
    return layout


def insert_visual_elements_in_layout(
    layout_ocr: WLayout | LLayout,
    layout: PLayout,
    threshold: float,
):
    """Insert visual elements from layout_ocr into layout
    if they are not inside any existing element in layout"""
    visual_elements = layout_ocr.get_visual_elements()
    for visual_element in visual_elements:
        if any(
            is_bbox_within(visual_element, element, threshold)
            for element in layout.get_elements_by_page(visual_element.page)
        ):
            continue
        layout.root.append(visual_element)
