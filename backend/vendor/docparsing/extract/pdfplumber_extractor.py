"""PdfPlumber Extractor"""

import io
import typing as _t
import logging

import pdfplumber
from pdfplumber.page import Page
from .base import OCRExtractor
from ..schemas import (
    Word,
    TableContent,
    ElementType,
    PLayout,
    WLayout,
    Extractor,
    VisualElement,
)
from ..utils import check_cid_error, check_unreadable_chars, is_bbox_within
from ..exceptions import (
    ManyCidError,
    ManyUnreadableCharError,
    PdfPlumberEmptyContent,
    PdfPlumberExtractionError,
)

logger = logging.getLogger(__name__)

DEFAULT_CONFIG: dict[str, _t.Any] = {
    "x_tolerance": 1,
    "y_tolerance": 1,
    "keep_blank_chars": False,
    "use_text_flow": True,
    "horizontal_ltr": True,
    "vertical_ttb": True,
    "extra_attrs": ["size", "fontname", "page_number"],
}


class PdfPlumberExtractor(OCRExtractor):
    """Class that perform OCR extraction
    and Tables extraction using pdfplumber.

    Parameters

    cid_error_threshold: float
    ---------
        Threshold for CID error detection (default: 0.1).
    unreadable_char_threshold: float
    ---------
        Threshold for unreadable characters detection (default: 0.1).
    word_threshold: float
    ---------
        Threshold for word-table overlap detection (default: 0.8).
    extract_visual_elements: bool
    ---------
        Whether to extract visual elements (solid horizontal lines) from the PDF (default: True).
    **kwargs
    ---------
        Additional keyword arguments for word extraction config.


    Examples
    --------
    ```python
    import io
    from docparsing.extract import PdfPlumberExtractor

    # Create a PdfPlumberExtractor instance
    extractor = PdfPlumberExtractor()

    # Extract words from a PDF file
    words = extractor.extract_words(io.BytesIO(open("example.pdf", "rb")))

    # Extract tables with content from a PDF file
    tables = extractor.extract_tables(io.BytesIO(open("example.pdf", "rb")))

    ```

    """

    def __init__(
        self,
        cid_error_threshold: float = 0.1,
        unreadable_char_threshold: float = 0.1,
        word_threshold: float = 0.8,
        extract_visual_elements: bool = True,
        **kwargs: dict[str, _t.Any],
    ) -> None:
        self.cid_error_threshold = cid_error_threshold
        self.unreadable_char_threshold = unreadable_char_threshold
        self.word_threshold = word_threshold
        self.extract_visual_elements = extract_visual_elements
        kwargs.pop("extra_attrs", None)
        self.extract_words_config = DEFAULT_CONFIG | kwargs

    def _extract_tables(
        self, tables: list[dict[str, _t.Any]], pdf_page: Page
    ) -> list[TableContent]:
        """Use pdfplumber to extract tables in page.
        Process table content and return TableContent list."""
        extracted: list[TableContent | None] = []
        table_texts = pdf_page.extract_tables(table_settings={})
        if len(tables) == len(table_texts):
            for obj, rows in zip(tables, table_texts):
                lines = [[cell if cell else "" for cell in row] for row in rows]
                # lines = repair_columns(lines)
                if len(lines) > 1 and any(
                    cell for row in lines for cell in row
                ):  # at least 2 lines
                    extracted.append(
                        TableContent.create(
                            x0=obj.bbox[0] / pdf_page.width,
                            x1=obj.bbox[2] / pdf_page.width,
                            y0=obj.bbox[1] / pdf_page.height,
                            y1=obj.bbox[3] / pdf_page.height,
                            page=pdf_page.page_number - 1,  # pdfplumber starts from 1
                            content=lines,
                            extractor=Extractor.PDFPLUMBER,
                        )
                    )
        return list(filter(None, extracted))

    def _extract_from_page(
        self, page: Page, type_specifier: str | None
    ) -> tuple[list[Word | VisualElement], list[TableContent]]:
        """Process pdfplumber page object to extract words and tables"""
        # ----- Extract images
        # images = extract_images(page.images)

        # ----- Extract tables
        table_list: list[TableContent] = []
        if type_specifier is None or type_specifier == ElementType.TABLE:
            if plumber_tables := page.find_tables(table_settings={}):
                tables = self._extract_tables(plumber_tables, page)
                table_list += tables

        word_list: list[Word | VisualElement] = []
        # ----- Extract words
        if type_specifier is None or type_specifier == ElementType.WORD:
            if words := page.extract_words(**self.extract_words_config):
                if check_cid_error(words, self.cid_error_threshold):
                    raise ManyCidError("CID error detected")
                if check_unreadable_chars(words, self.unreadable_char_threshold):
                    raise ManyUnreadableCharError(
                        "Too many unreadable characters detected"
                    )
                for word_dict in words:
                    # Ensure fontname is a str when pdfplumber returns bytes for fontname
                    fontname = (
                        word_dict["fontname"].decode("utf-8", errors="ignore")
                        if isinstance(word_dict["fontname"], bytes)
                        else word_dict["fontname"]
                    )
                    word = Word.create(
                        x0=word_dict["x0"] / page.width,
                        x1=word_dict["x1"] / page.width,
                        y0=word_dict["top"] / page.height,
                        y1=word_dict["bottom"] / page.height,
                        content=word_dict["text"],
                        page=word_dict["page_number"] - 1,  # pdfplumber starts from 1
                        size=word_dict["size"],
                        fontname=fontname,
                        extractor=Extractor.PDFPLUMBER,
                        vertical=not word_dict["upright"],
                    )
                    if word is not None and not any(
                        is_bbox_within(word, table, self.word_threshold)
                        for table in table_list
                    ):
                        word_list.append(word)

        # ----- Extract visual elements (solid horizontal lines)
        if self.extract_visual_elements:
            for line_dict in page.lines:
                # filter out very thin lines / vertical lines
                if line_dict["width"] < 10:
                    continue
                visual_element = VisualElement.create(
                    x0=line_dict["x0"] / page.width,
                    x1=line_dict["x1"] / page.width,
                    y0=line_dict["top"] / page.height,
                    y1=(line_dict["bottom"] + 1) / page.height,
                    page=line_dict["page_number"] - 1,  # pdfplumber starts from 1
                    size=line_dict["height"],
                    fontname="",
                    extractor=Extractor.PDFPLUMBER,
                )
                if visual_element is not None:
                    word_list.append(visual_element)
        return word_list, table_list

    def extract_elements(
        self,
        file_content: io.BytesIO,
        type_specifier: _t.Literal[ElementType.WORD, ElementType.TABLE] | None = None,
    ) -> tuple[WLayout, PLayout]:
        """Extract elements from file content using pdfplumber

        Parameters
        ----------
        file_content: io.BytesIO
            File content to extract elements from
        type_specifier: ElementType.WORD | ElementType.TABLE | None
            Type of element to extract. If None, extract both words and tables.

        Returns
        -------
        tuple[WLayout, PLayout]
            tuple of OCR Layout of extracted words and Layout of extracted tables
        """
        if file_content.getbuffer().nbytes == 0:
            return WLayout([]), PLayout([])
        extract_words: list[Word | VisualElement] = []
        extract_tables: list[TableContent] = []
        try:
            with pdfplumber.open(file_content) as pdf:
                if pdf.pages:
                    for page in pdf.pages:
                        words, tables = self._extract_from_page(page, type_specifier)
                        extract_words += words
                        extract_tables += tables
        except Exception as e:
            logger.exception(e)
            raise PdfPlumberExtractionError from e
        if not extract_tables and not extract_words:
            raise PdfPlumberEmptyContent
        return WLayout(extract_words), PLayout(extract_tables)

    def extract_words(self, file_content: io.BytesIO) -> WLayout:
        """Extract words from file content using pdfplumber

        Parameters
        ----------
        file_content: io.BytesIO
            File content to extract words from

        Returns
        -------
        WLayout
            OCR Layout of extracted words
        """
        layout_ocr, _ = self.extract_elements(
            file_content, type_specifier=ElementType.WORD
        )
        return layout_ocr

    def extract_tables(self, file_content: io.BytesIO) -> PLayout:
        """Extract tables from file content using pdfplumber

        Parameters
        ----------
        file_content: io.BytesIO
            File content to extract tables from

        Returns
        -------
        PLayout
            Layout of extracted tables with content
        """
        _, layout = self.extract_elements(
            file_content, type_specifier=ElementType.TABLE
        )
        return layout
