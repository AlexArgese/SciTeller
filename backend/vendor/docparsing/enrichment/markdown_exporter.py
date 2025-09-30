"""Module to export layout elements to markdown format"""

from typing import Literal
from defusedxml import defuse_stdlib
from pydantic import BaseModel, Field
from .config import EnrichmentConfig
from .utils import get_lines, count_start_chars
from .xml_to_markdown import xml_to_markdown
from ..schemas.elements import ElementType, Word, Paragraph, PLayout, WLayout, LLayout

# Make standard XML libraries secure
defuse_stdlib()
# using "nosec" to avoid bandit issue as it is fixed by calling defuse_stdlib() before the import
from xml.etree import ElementTree as ET  # nosec # pylint: disable=C0413, C0411 # noqa: E402


class MarkdownExporter(BaseModel):
    """Export layout elements to markdown format

    Attributes
    ----------
    enrichment_config: EnrichmentConfig
        Enrichment configuration

    Methods:
    export_md: Convert layout to markdown format
    export_md_from_xml: Convert XML to markdown format
    """

    enrichment_config: EnrichmentConfig = Field(
        default_factory=EnrichmentConfig,
        description="Enrichment configuration",
    )

    def _join_words(self, words: list[Word]) -> str:
        """Join words in a paragraph with bold and italic formatting"""
        markdown = ""
        current_bold = False
        current_italic = False
        for word in words:
            if word.is_bold != current_bold:
                if current_bold:
                    markdown = markdown.strip() + "** "
                if word.is_bold:
                    markdown += "**"
                current_bold = word.is_bold
            if word.is_italic != current_italic:
                if current_italic:
                    markdown += markdown.strip() + "* "
                if word.is_italic:
                    markdown += "*"
                current_italic = word.is_italic
            markdown += word.content + " "

        # Remove trailing space and close any open formatting
        markdown = markdown.strip()
        if current_bold:
            markdown += "**"
        if current_italic:
            markdown += "*"
        return markdown

    def _modify_starter(self, word: Word, list_type: str) -> str:
        """Modify list starter based on list type"""
        if list_type == "dash" and word.content.startswith(
            tuple(self.enrichment_config.list_starters)
        ):
            return "\n- " + word.content[1:].strip()
        if list_type == "upper" and word.content[0].isupper():
            return "\n- " + word.content
        if list_type == "number":
            chapter = self.enrichment_config.regex_num_starter.match(word.content)
            if chapter:
                number = chapter.group(0)
                if number.endswith("."):
                    return f"\n{number} {word.content[len(number):].strip()}"
                return f"\n{number}. {word.content[len(number):].strip()}"
        return " " + word.content

    def _join_list(
        self, words: list[Word], list_start_index: list[int], list_type: str
    ) -> str:
        """Join list elements based on list type"""
        markdown = ""
        for i, word in enumerate(words):
            if i in list_start_index:
                markdown += self._modify_starter(word, list_type)
            else:
                markdown = markdown.strip() + " " + word.content
        return markdown

    def _split_list(self, elem: Paragraph) -> str:
        """Split list elements by indentation and return markdown"""
        # List elements starting a new line based on indentation
        lines = get_lines(elem.content)

        # Count the number of list starters for each type
        start_chars = count_start_chars(
            lines,
            self.enrichment_config.list_starters,
            self.enrichment_config.regex_num_starter,
        )
        # Determine the type of list based on the len of list starters
        # and join the list elements accordingly
        if len(start_chars["dash"]) > 1:
            return self._join_list(elem.content, start_chars["dash"], "dash")
        elif len(start_chars["number"]) > 1:
            return self._join_list(elem.content, start_chars["number"], "number")
        elif len(start_chars["upper"]) > 1:
            return self._join_list(elem.content, start_chars["upper"], "upper")
        else:
            return self._join_words(elem.content)

    def export_md(self, layout: PLayout | WLayout | LLayout) -> str:
        """Convert layout to markdown format"""
        markdown = ""
        previous_title = 0
        for elem in layout.root:
            if elem.type == ElementType.WORD:
                return self._join_words(layout.root)
            if isinstance(elem, Paragraph):
                if elem.type == ElementType.LIST:
                    markdown += self._split_list(elem) + "\n\n"
                    previous_title = 1 if previous_title != 0 else 0
                    continue
                if elem.type == ElementType.TITLE:
                    markdown += f"\n{'#' * min(previous_title + 1, 6)} "
                    previous_title += 1
                else:
                    previous_title = 1 if previous_title != 0 else 0
                markdown += self._join_words(elem.content) + "\n\n"

            elif elem.type == ElementType.TABLE_CONTENT:
                if elem.content:
                    markdown += "|" + "|".join(elem.content[0]) + "|\n"
                    markdown += "|" + "---|" * len(elem.content[0]) + "\n"
                    for row in elem.content[1:]:
                        markdown += "|" + "|".join(row) + "|\n"
                    markdown += "\n\n"
                previous_title = 1 if previous_title != 0 else 0

            elif elem.type == ElementType.LINE:
                markdown += self._join_words(elem.content) + "\n"

        return markdown.replace("\n\n\n", "\n\n")

    def export_md_from_xml(
        self,
        file_path: str | None = None,
        xml_tree: str | None = None,
        root: ET.Element | None = None,
        output_path: str | None = None,
        table_format: Literal["latex", "markdown"] | None = None,
    ) -> str | None:
        """Convert XML to markdown format"""
        if file_path is not None:
            tree = ET.parse(file_path)  # nosec
            root = tree.getroot()
        elif xml_tree is not None:
            root = ET.fromstring(xml_tree)  # nosec
        if root is None:
            return ""
        if table_format is not None:
            self.enrichment_config.markdown_exporter_table_format = table_format
        markdown = xml_to_markdown(
            root,
            self.enrichment_config.list_starters,
            self.enrichment_config.markdown_exporter_table_format,
        )
        # Save markdown to file
        if output_path:
            with open(output_path, "w", encoding="utf-8") as file:
                file.write(markdown)
        else:
            return markdown
