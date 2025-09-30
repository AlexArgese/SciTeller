"""Configuration for the enrichment module"""

import re
from typing import Literal, Pattern
from pydantic import BaseModel, Field

LIST_STARTERS: list[str] = [
    "\uf071",
    "-",
    "⁃",
    "–",
    "•",
    "●",
    "·",
    "\uf0b7",
    "❏",
    "",
    "▪",
]
REGEX_NUM_STARTER: Pattern[str] = re.compile(r"^(?:\d+\.\d*|\.\d+)(\.\d+)*$")
# e.g. : .1 or 1. or 1.12 or 1.12.1 but not 1

REGEX_REMOVE_HEADER: list[Pattern[str]] = [re.compile(r"^\d+$")]


class EnrichmentConfig(BaseModel):
    """Configuration for the enrichment module"""

    document_language: Literal["auto", "en", "fr"] = Field(
        default="auto",
        description="Language of the document. Used by WordNinja to set the dictionary"
        " for word splitting after word merge. <br>"
        "auto: auto-detect the language with py3langid. <br>"
        "en: use English dictionary provided by WordNinja for word splitting. <br>"
        "fr: use French dictionary in docparsing resources for word splitting with WordNinja.",
        json_schema_extra={"x-category": "advanced"},
    )
    list_starters: list[str] = Field(
        default_factory=lambda: LIST_STARTERS,
        description="List of characters that can be detected as list starters. "
        "Used to update the element type from text to list. "
        "Or to format an element predicted as a list in the markdown exporter.",
        json_schema_extra={"x-category": "advanced"},
    )
    regex_num_starter: Pattern[str] = Field(
        default_factory=lambda: REGEX_NUM_STARTER,
        description="Regular expression to match numbers at the start"
        " of a line that can be detected as list starters. "
        "Used to update the element type from text to list. "
        "Or to format an element predicted as a list in the markdown exporter.",
        json_schema_extra={"x-category": "advanced"},
    )
    vertical_paragraph_anchor: Literal["top", "bottom", "inplace", "no"] = Field(
        default="no",
        description="Where to anchor vertical paragraphs in the layout: <br>"
        "top: anchor at the top of the page, <br>"
        "bottom: anchor at the bottom of the page, <br>"
        "inplace: anchor according to the y0 position of the paragraph in the reading order of the page, <br>"
        "no: do not modify the position of a vertical paragraph",
        json_schema_extra={"x-category": "advanced"},
    )
    extractor_list_update_policy: Literal["all", "yolo", "none"] = Field(
        default="yolo",
        description="Which extractor to check before updating the element type from text to list: <br>"
        "all: update the element type from text to list for all extractors, <br>"
        "yolo: update the element type from text to list only for the YOLO extractor, <br>"
        "none: do not update the element type from text to list",
        json_schema_extra={"x-category": "advanced"},
    )
    list_starters_policy: Literal["all", "dash", "number", "none"] = Field(
        default="all",
        description="Which list starters to consider: <br>"
        "all: Consider all characters in the list_starters as valid list starters.<br>"
        "dash: Only consider the dash character as a valid list starter.<br>"
        "number: Only consider numbers at the start of a line as valid list starters.<br>"
        "none: Do not consider any characters as list starters, treating all lines as normal text.",
        json_schema_extra={"x-category": "advanced"},
    )
    word_merge_policy: Literal["all", "vertical", "none"] = Field(
        default="all",
        description="Which policy for merging exploded words: <br>"
        "all: Merge all words detected as exploded, regardless of their orientation.<br>"
        "vertical: Merge only vertical words detected as exploded, preserving horizontal words.<br>"
        "none: Do not merge any words, keeping them in their original form.",
        json_schema_extra={"x-category": "advanced"},
    )
    split_long_words: bool = Field(
        default=False,
        description="Split long words into smaller parts"
        " based on max_word_length. If True, WordNinja will be used to split long words.<br>"
        "True: Split long words into smaller parts using WordNinja.<br>"
        "False: Do not split long words, keeping them as they are.",
        json_schema_extra={"x-category": "advanced"},
    )
    max_word_length: int = Field(
        default=30,
        description="Maximum length of a word over which it is considered as merged."
        " So WordNinja will not be used to split it, if split_long_words is True.<br>"
        "30: If a word is longer than 30 characters, it will be considered as merged.",
        json_schema_extra={"x-category": "advanced"},
    )
    allow_cross_page_nodes: bool = Field(
        default=True,
        description="Allow cross-page nodes in the tree structure (default: True). <br>"
        "If True, nodes can span across multiple pages.<br>"
        " If False, nodes are restricted to a single page."
        " So an element on a page can not be a child of a Title from a previous page.",
        json_schema_extra={"x-category": "advanced"},
    )
    normalize_form: Literal["no", "NFC", "NFD", "NFKC", "NFKD"] = Field(
        default="NFD",
        description="Normalization form for the text: 'no', 'NFC' or 'NFD' or 'NFKC' or 'NFKD'. "
        "default: 'NFD' (Canonical Decomposition).<br>"
        "no: Do not apply any normalization to the text.<br>"
        "NFC: Preserves precomposed characters (e.g., 'é' remains as a single code point U+00E9)<br>"
        "NFD: Splits characters into their base form and diacritical marks (e.g., 'é' → 'e' + U+0301)<br>"
        "NFKC: Converts compatibility characters (e.g., bold letters and full-width digits) into their standard equivalents<br>"
        "NFKD: Like NFD, but also applies compatibility mappings, breaking down formatted characters into their plain-text equivalents",
        json_schema_extra={"x-category": "advanced"},
    )
    clean_cid_error: bool = Field(
        default=True,
        description="Remove CID errors from the content of elements. "
        "If True, CID errors will be removed from the content of elements.<br>"
        "If False, CID errors will be kept in the content of elements.",
        json_schema_extra={"x-category": "advanced"},
    )
    clean_unreadable_chars: bool = Field(
        default=True,
        description="Remove unreadable characters from the content of elements. "
        "If True, unreadable characters will be removed from the content of elements.<br>"
        "If False, unreadable characters will be kept in the content of elements.",
        json_schema_extra={"x-category": "advanced"},
    )
    remove_extra: Literal["all", "header", "footer", "none"] = Field(
        default="none",
        description="Target for removing extra elements: True, 'header', 'footer', False or 'none'. <br>"
        "True: remove all extra elements matching the regex, <br>"
        "'header': remove headers elements matching the regex, <br>"
        "'footer': remove footers elements matching the regex, <br>"
        "False: do not remove extra elements",
        json_schema_extra={"x-category": "advanced"},
    )
    remove_extra_pattern: list[Pattern[str]] = Field(
        default_factory=lambda: REGEX_REMOVE_HEADER,
        description="Regular expressions to match extra elements to remove"
        " (default: [re.compile(r'^\\d+$')])",
        json_schema_extra={"x-category": "advanced"},
    )
    markdown_exporter_table_format: Literal["latex", "markdown"] = Field(
        default="markdown",
        description="Table format for markdown exporter:<br>"
        " 'latex': use LaTeX table format,<br>"
        " 'markdown': use markdown table format",
        json_schema_extra={"x-category": "core"},
    )
    xml_exporter_table_format: Literal["latex", "html"] = Field(
        default="html",
        description="Table format for XML exporter:<br>"
        " 'latex': use LaTeX table format,<br>"
        " 'html': use HTML table format",
        json_schema_extra={"x-category": "core"},
    )
    join_consecutive_text: bool = Field(
        default=False,
        description="Join consecutive text elements between two pages"
        " into a single element based on conditions: <br>"
        " - the last text element of the first page doesn't end with a dot, "
        "and the first text element of the second page doesn't start with a capital letter).<br>"
        " - there are only Headers or Footers elements between them.",
        json_schema_extra={"x-category": "core"},
    )
    join_consecutive_list: bool = Field(
        default=False,
        description="Join consecutive list elements between two pages"
        " into a single element based on conditions: <br>"
        " - the first element of the second page is a list, and starts with a list starter <br>"
        " - there are only Headers or Footers elements between them.",
        json_schema_extra={"x-category": "core"},
    )
    join_consecutive_table: bool = Field(
        default=True,
        description="Join consecutive table elements between two pages"
        "into a single element based on conditions: <br>"
        " - the first row of both tables are not the same <br>"
        " - both tables have the same number of columns <br>"
        " - column boundaries are matching with each other <br>"
        " - the second table doesn't have a header<br>"
        " - there are only Headers or Footers elements between them.",
        json_schema_extra={"x-category": "core"},
    )
    column_boundaries_tolerance: float = Field(
        default=0.25,
        description="Control the tolerance for overlapping column boundaries of consecutive tables."
        " If join_consecutive_table is False, this option does nothing.",
        json_schema_extra={"x-category": "advanced"},
    )
