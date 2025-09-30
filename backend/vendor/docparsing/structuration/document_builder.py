"""Module to build a structured document from a layout and an OCR layout"""

import re
from typing import Literal, Callable, Pattern


from .build_lines import (
    build_lines_from_bbox,
    build_lines_from_ocr_order,
)
from .utils import populate_paragraphs, insert_visual_elements_in_layout
from .sort_layout import (
    detect_columns,
    sort_layout_by_reading_order,
)
from .refine_layout_order import refine_layout_order
from ..extract.utils import populate_tables
from ..schemas import WLayout, LLayout, ElementType, PLayout, Word


BUILD_LINES_METHODS: dict[
    str,
    Callable[[WLayout, float], LLayout] | Callable[[WLayout], LLayout],
] = {
    "bbox": build_lines_from_bbox,
    "ocr_order": build_lines_from_ocr_order,
}

REGEX_CHAPTERS = [re.compile(r"^\d+(\.\d+)+")]


class DocumentBuilder:
    """Class to build a structured document from an OCR layout and a layout(optional)

    Parameters
    ----------
    build_lines_method: Literal["bbox", "ocr_order"]
        Method to build lines from words
    threshold_word_in_line: float
        Threshold to consider a word inside a line
    threshold_word_in_paragraph: float
        Threshold to consider a word inside a paragraph
    threshold_word_in_table: float
        Threshold to consider a word inside a table
    threshold_visual_element_in_element: float
        Threshold to consider a visual element inside an element


    Examples
    --------
    ```python
    import io
    from docparsing.structuration import DocumentBuilder
    from docparsing.extract import DoctrExtractor
    from docparsing.layout import DetectronLayoutExtractor
    from docparsing.schemas import Word, PLayout

    # Extract OCR Layout from a PDF file
    extractor = DoctrExtractor()
    ocr_layout = extractor.extract_words(io.BytesIO(open("example.pdf", "rb")))

    # Extract Layout from a PDF file
    extractor = Detectron2Extractor()
    layout = extractor.extract_elements(io.BytesIO(open("example.pdf", "rb")))

    # Create a DocumentBuilder instance
    builder = DocumentBuilder()

    # Build a structured document from a layout and an OCR layout
    structured_document = builder.build_document(ocr_layout, layout)

    ```

    """

    def __init__(
        self,
        build_lines_method: Literal["bbox", "ocr_order"] = "bbox",
        regex_chapters: list[Pattern[str]] | None = None,
        threshold_word_in_line: float = 0.6,
        threshold_word_in_paragraph: float = 0.25,
        threshold_word_in_table: float = 0.5,
        threshold_visual_element_in_element: float = 0.5,
    ) -> None:
        self.build_line_method = BUILD_LINES_METHODS[build_lines_method]
        self.regex_chapters = regex_chapters if regex_chapters else REGEX_CHAPTERS
        self.threshold_word_in_line = threshold_word_in_line
        self.threshold_word_in_paragraph = threshold_word_in_paragraph
        self.threshold_word_in_table = threshold_word_in_table
        self.threshold_visual_element_in_element = threshold_visual_element_in_element

    def build_document(
        self,
        layout_ocr: WLayout | LLayout,
        layout: PLayout | None = None,
        look_for_columns: bool = True,
        look_for_chapters: bool = True,
    ) -> PLayout:
        """Build a structured document from an OCR layout and a layout(optional)

        Parameters
        ----------
        layout_ocr: WLayout | LLayout
            OCR layout to use to populate the layout
        layout: PLayout | None
            Layout to populate with OCR content (default: None)
        look_for_columns: bool
            Whether to look for columns in the layout
        look_for_chapters: bool
            Whether to look for chapters in the layout

        Returns
        -------
        PLayout
            Populated layout with OCR content

        """
        # Detect columns in layout and sort elements by reading order
        columns = None
        if look_for_columns and layout:
            columns = detect_columns(layout, layout_ocr)
            layout = sort_layout_by_reading_order(layout, columns)

        # Convert layout_ocr to Layout[Line] using build_line_method
        if layout_ocr.root and any(isinstance(elem, Word) for elem in layout_ocr.root):
            layout_ocr = self.build_line_method(
                layout_ocr, self.threshold_word_in_line, columns
            )

        # Populate tables with ocr content
        if layout and any(element.type == ElementType.TABLE for element in layout.root):
            layout = populate_tables(
                layout_ocr,
                layout,
                threshold_word=self.threshold_word_in_table,
                pop_words=True,
            )
        # Populate paragraphs with ocr content
        layout = populate_paragraphs(
            layout_ocr,
            layout=layout,
            look_for_chapters=look_for_chapters,
            regex_chapters=self.regex_chapters,
            columns_by_page=columns,
            threshold_word=self.threshold_word_in_paragraph,
        )

        # add visual elements from layout_ocr to layout before sorting
        insert_visual_elements_in_layout(
            layout_ocr,
            layout,
            self.threshold_visual_element_in_element,
        )
        # Text_inferred bboxes are set, Sort by reading order again
        if look_for_columns and layout:
            # remove previous metadata columns
            for elem in layout.root:
                elem.metadata.pop("columns", None)
            # Sort from top to bottom before detecting columns
            layout.sort_by_bbox()
            columns = detect_columns(layout)
            layout = sort_layout_by_reading_order(layout, columns)
            refine_layout_order(layout, columns)
        # Empty elements with no content
        return layout.filter_empty_elements()
