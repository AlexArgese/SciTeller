"""Settings for the different jobs in the docparsing module"""

from typing import Literal, Pattern
from pydantic import BaseModel, Field
from pydantic.json_schema import SkipJsonSchema
from ..model.detectron2 import DEFAULT_LABEL_MAP
from ..structuration.document_builder import REGEX_CHAPTERS
from ..visualization import COLORS
from ..visualization import (
    DEFAULT_FONT,
    THICKNESS,
    FONT_SIZE,
    LABEL_SHIFT,
)


class PdfPlumberSettings(BaseModel):
    """Settings for PdfPlumberExtractor"""

    cid_error_threshold: float = Field(
        default=0.1,
        description="Threshold for CID error in PDF, "
        "if exceeded, the fallback OCR (Doctr) will be used. "
        "This is a ratio of the number of words with CID errors to the total number of words.<br>"
        "0.1: If 10% of the words in the PDF have CID errors, "
        "the fallback OCR (Doctr) will be used to extract text.",
        json_schema_extra={"x-category": "core"},
    )
    unreadable_char_threshold: float = Field(
        default=0.1,
        description="Threshold for unreadable characters in PDF, "
        "if exceeded, the fallback OCR (Doctr) will be used. "
        "This is a ratio of the number of words with unreadable characters to the total number of words.<br>"
        "0.1: If 10% of the words in the PDF have unreadable characters, "
        "the fallback OCR (Doctr) will be used to extract text.",
        json_schema_extra={"x-category": "core"},
    )
    word_threshold: float = Field(
        default=0.8,
        description="Threshold to determine whether a word is part of a table or not. "
        "If the ratio of the word area matched to the table area is above this threshold, "
        "the word is considered part of the table.<br>"
        "0.8: If 80% of the word area matches the table area, "
        "the word is considered part of the table.",
        json_schema_extra={"x-category": "core"},
    )
    extract_visual_elements: bool = Field(
        default=True,
        description="Whether to extract visual elements (solid horizontal lines) from the PDF."
        "Solid lines are used as a separation when sorting the layout elements by reading order.",
        json_schema_extra={"x-category": "core"},
    )
    x_tolerance: int = Field(
        default=1,
        description="X tolerance of PdfPlumber WordExtractor."
        " This is the maximum horizontal distance between words"
        " to consider them as part of the same line.",
        json_schema_extra={"x-category": "advanced"},
    )
    y_tolerance: int = Field(
        default=1,
        description="Y tolerance of PdfPlumber WordExtractor."
        " This is the maximum vertical distance between words"
        " to consider them as part of the same line.",
        json_schema_extra={"x-category": "advanced"},
    )
    keep_blank_chars: SkipJsonSchema[bool] = Field(
        default=False,
        description="Keep blank characters in the extracted words.",
    )
    use_text_flow: bool = Field(
        default=True,
        description="Use text flow for word extraction.",
        json_schema_extra={"x-category": "advanced"},
    )
    horizontal_ltr: bool = Field(
        default=True,
        description="Use horizontal left-to-right text flow.",
        json_schema_extra={"x-category": "advanced"},
    )
    vertical_ttb: bool = Field(
        default=True,
        description="Use vertical top-to-bottom text flow.",
        json_schema_extra={"x-category": "advanced"},
    )
    extra_attrs: SkipJsonSchema[list[str]] = Field(
        default_factory=lambda: ["size", "fontname", "page_number"],
        description="Extra attributes to extract from the words.",
    )


class DoctrSettings(BaseModel):
    """Settings for Doctr Model"""

    det_arch: SkipJsonSchema[str] = Field(
        default="Felix92/onnxtr-db-resnet50",
        description="Architecture of the detection model.",
    )
    reco_arch: SkipJsonSchema[str] = Field(
        default="Felix92/onnxtr-crnn-vgg16-bn",
        description="Architecture of the recognition model.",
    )
    resolve_blocks: SkipJsonSchema[bool] = Field(
        default=True,
        description="Resolve blocks in the OCR output.",
    )
    load_in_8_bit: SkipJsonSchema[bool] = Field(
        default=True,
        description="Load the model in 8-bit mode.",
    )


class DoctrExtractorSettings(BaseModel):
    """Settings for DoctrExtractor"""

    image_dpi: int = Field(
        default=300,
        description="DPI of the input image.",
        json_schema_extra={"x-category": "advanced"},
    )
    grayscale: bool = Field(
        default=False,
        description="Convert image to grayscale.",
        json_schema_extra={"x-category": "advanced"},
    )


class Detectron2Settings(BaseModel):
    """Settings for Detectron2 Model"""

    label_map: SkipJsonSchema[dict[int, str]] = Field(
        default_factory=lambda: DEFAULT_LABEL_MAP,
        description="Label map for the model.",
    )
    paragraph_threshold: float = Field(
        default=0.5,
        description="Threshold for paragraph detection confidence.<br>"
        "0.5: If the confidence of paragraph detection is above 0.5, "
        "the paragraph is considered detected. Else, it is ignored.",
        json_schema_extra={"x-category": "core"},
    )
    table_threshold: float = Field(
        default=0.5,
        description="Threshold for table detection confidence.<br>"
        "0.5: If the confidence of table detection is above 0.5, "
        "the table is considered detected. Else, it is ignored.",
        json_schema_extra={"x-category": "core"},
    )


class Detectron2ExtractorSettings(BaseModel):
    """Settings for Detectron2Extractor"""

    image_dpi: int = Field(
        default=300,
        description="DPI of the input image.",
        json_schema_extra={"x-category": "advanced"},
    )
    grayscale: bool = Field(
        default=False,
        description="Convert image to grayscale.",
        json_schema_extra={"x-category": "advanced"},
    )


class Yolov10Settings(BaseModel):
    """Settings for Yolov10 Model"""

    repo_id: SkipJsonSchema[str] = Field(
        default="juliozhao/DocLayout-YOLO-DocStructBench",
        description="Hugging Face repository ID.",
    )
    filename: SkipJsonSchema[str] = Field(
        default="doclayout_yolo_docstructbench_imgsz1024.pt",
        description="Filename of the pre-trained model.",
    )
    threshold: float = Field(
        default=0.5,
        description="Confidence threshold for layout elements.<br>"
        "0.5: If the confidence of a layout element is above 0.5, "
        "the element is considered detected. Else, it is ignored.",
        json_schema_extra={"x-category": "core"},
    )


class Yolov10ExtractorSettings(BaseModel):
    """Settings for Yolov10Extractor"""

    image_dpi: int = Field(
        default=300,
        description="DPI of the input image.",
        json_schema_extra={"x-category": "advanced"},
    )
    grayscale: bool = Field(
        default=False,
        description="Convert image to grayscale.",
        json_schema_extra={"x-category": "advanced"},
    )


class TatrSettings(BaseModel):
    """Settings for Tatr Model"""

    detection_model: SkipJsonSchema[str] = Field(
        default="lettria/onnx-tatr-det",
        description="Path to the detection model.",
    )
    structure_model: SkipJsonSchema[str] = Field(
        default="lettria/onnx-tatr-struct-v1.1-all",
        description="Path to the structure model.",
    )
    table_threshold: float = Field(
        default=0.5,
        description="Threshold for table detection confidence.<br>"
        "0.5: If the confidence of table detection is above 0.5, "
        "the table is considered detected. Else, it is ignored.",
        json_schema_extra={"x-category": "core"},
    )


class TatrExtractorSettings(BaseModel):
    """Settings for TatrLayoutExtractor"""

    image_dpi: int = Field(
        default=300,
        description="DPI of the input image.",
        json_schema_extra={"x-category": "advanced"},
    )
    grayscale: bool = Field(
        default=False,
        description="Convert image to grayscale.",
        json_schema_extra={"x-category": "advanced"},
    )
    spanning_cell_overlap_threshold: float = Field(
        default=0.5,
        description="Threshold for spanning cell overlap with normal cells."
        " If the area of a normal cell overlaps with a spanning cell "
        "by more than this threshold, the normal cell is considered part of the spanning cell.<br>"
        "0.5: If the area of a normal cell overlaps with a spanning cell "
        "by more than 50%, the normal cell is considered part of the spanning cell.",
        json_schema_extra={"x-category": "core"},
    )
    header_threshold: float = Field(
        default=0.8,
        description="Threshold for header detection confidence. default: 0.8."
        "Used to avoid merging tables over two pages when the 2nd page table starts with a header."
        "Lower values will detect more headers and then avoid to merge more tables."
        "Higher values will detect less headers and then merge more tables.",
    )


class AggregateLayoutsSettings(BaseModel):
    """Settings for aggregate_layouts"""

    overlapping_threshold_paragraph: float = Field(
        default=0.25,
        description="Threshold for overlapping paragraphs.<br>"
        "0.25: If the overlap ratio of two paragraphs' areas is above 0.25, "
        "they are considered overlapping and one of them will be removed.",
        json_schema_extra={"x-category": "advanced"},
    )
    overlapping_threshold_table: float = Field(
        default=0.5,
        description="Threshold for overlapping tables.<br>"
        "0.5: If the overlap ratio of two tables' areas is above 0.5, "
        "they are considered overlapping and one of them will be removed.",
        json_schema_extra={"x-category": "advanced"},
    )


class DocumentBuilderSettings(BaseModel):
    """Settings for DocumentBuilder"""

    build_lines_method: Literal["bbox", "ocr_order"] = Field(
        default="bbox",
        description="Method to build lines before populating the layout with OCR content, "
        "in order to insert the words in the right order in the layout.<br>"
        "bbox: Use the bounding box of words to build lines.<br>"
        "ocr_order: Use the order of words in the OCR output to build lines.",
        json_schema_extra={"x-category": "core"},
    )
    regex_chapters: list[Pattern[str]] = Field(
        default_factory=lambda: REGEX_CHAPTERS,
        description="List of regex patterns to detect chapters."
        "Used in populate_paragraphs() to identify chapters from OCR extracted text."
        "When the layout detection is not accurate, "
        "we will be able to insert them before the title content.",
        json_schema_extra={"x-category": "advanced"},
    )
    threshold_word_in_line: float = Field(
        default=0.6,
        description="Threshold to determine whether a word is in a line "
        "when using the 'bbox' build_lines_method."
        "If the ratio of the word area matched to the line area is above this threshold, "
        "the word is considered part of the line.<br>"
        "0.6: If 60% of the word area matches the line area, "
        "the word is considered part of the line.",
        json_schema_extra={"x-category": "advanced"},
    )
    threshold_word_in_paragraph: float = Field(
        default=0.25,
        description="Threshold to determine whether a word is in a paragraph "
        "when processing : populate_paragraphs()."
        "If the ratio of the word area matched to the paragraph area is above this threshold, "
        "the word is considered part of the paragraph.<br>"
        "0.25: If 25% of the word area matches the paragraph area, "
        "the word is considered part of the paragraph.",
        json_schema_extra={"x-category": "advanced"},
    )
    threshold_word_in_table: float = Field(
        default=0.5,
        description="Threshold to determine whether a word is in a table "
        "when processing : populate_tables()."
        "If the ratio of the word area matched to the table area is above this threshold, "
        "the word is considered part of the table.<br>"
        "0.5: If 50% of the word area matches the table area, "
        "the word is considered part of the table.",
        json_schema_extra={"x-category": "advanced"},
    )
    threshold_visual_element_in_element: float = Field(
        default=0.5,
        description="Threshold to determine whether a visual element is in an element "
        "when processing : populate_visual_elements(). "
        "If the ratio of the visual element area matched to any element area "
        "is above this threshold, the visual element will be removed <br>",
        json_schema_extra={"x-category": "advanced"},
    )


class BuildDocumentSettings(BaseModel):
    """Settings for build_document"""

    look_for_columns: bool = Field(
        default=True,
        description="Whether to look for text columns in the document structure "
        "using the Layout and the OCR predictions. <br>"
        "True: the function will detect gap columns between elements "
        "that are be used to sort the layout according to the reading order. <br>"
        "This allow to read a section and then going up on the page to read the next section. "
        "False: the function will not look for columns and each page is read from top to bottom. ",
        json_schema_extra={"x-category": "advanced"},
    )
    look_for_chapters: bool = Field(
        default=True,
        description="Whether to look for chapters in the document structure "
        "using the regex_chapters list during populate_paragraphs().<br>"
        "True: Look for chapters in the document structure using the regex_chapters list.<br>"
        "False: Do not look for chapters in the document structure.",
        json_schema_extra={"x-category": "advanced"},
    )


class VisualizeSettings(BaseModel):
    """Settings for visualization."""

    image_dpi: int = Field(
        default=300,
        description="DPI of the output image.",
        json_schema_extra={"x-category": "advanced"},
    )
    grayscale: bool = Field(
        default=False,
        description="Convert image to grayscale.",
        json_schema_extra={"x-category": "advanced"},
    )
    colors: SkipJsonSchema[dict[str, tuple[int, int, int]]] = Field(
        default_factory=lambda: COLORS,
        description="Dictionary of colors for each type of elements."
        "Default colors are:<br>"
        "    'word': yellow<br>"
        "    'line': orange<br>"
        "    'text': red<br>"
        "    'title': blue<br>"
        "    'list': cyan<br>"
        "    'extra': light_red<br>"
        "    'header': light_red<br>"
        "    'footer': light_red<br>"
        "    'cell': purple<br>"
        "    'spanning_cell': dark_purple<br>"
        "    'cell_header': dark_pink<br>"
        "    'spanning_header': pink<br>"
        "    'table': brown<br>"
        "    'tablecontent': green<br>"
        "    'columns': blue<br>"
        "    'inferred': black<br>"
        "    'word_idx': pink",
    )
    thickness: int = Field(
        default=THICKNESS,
        description="Thickness of the bounding boxes.",
        json_schema_extra={"x-category": "advanced"},
    )
    draw_cells: bool = Field(
        default=True,
        description="Whether to draw the cells in the layout.",
        json_schema_extra={"x-category": "advanced"},
    )
    label: bool = Field(
        default=True,
        description="Whether to draw the label on the bounding boxes.",
        json_schema_extra={"x-category": "advanced"},
    )
    label_confidence: bool = Field(
        default=True,
        description="Whether to draw the confidence on the label.",
        json_schema_extra={"x-category": "advanced"},
    )
    cell_label: bool = Field(
        default=True,
        description="Whether to draw the label on the cell bounding boxes.",
        json_schema_extra={"x-category": "advanced"},
    )
    font: str = Field(
        default=DEFAULT_FONT,
        description="Font type for the text.",
        json_schema_extra={"x-category": "advanced"},
    )
    font_size: int = Field(
        default=FONT_SIZE,
        description="Font scale for the text.",
        json_schema_extra={"x-category": "advanced"},
    )
    label_shift: int = Field(
        default=LABEL_SHIFT,
        description="Shift value of where to print the label of an element.",
        json_schema_extra={"x-category": "advanced"},
    )
    columns: bool = Field(
        default=False,
        description="Whether to draw the gap columns detected between layout elements.",
        json_schema_extra={"x-category": "core"},
    )
    word_from_paragraph: bool = Field(
        default=False,
        description="Whether to draw the words bbox inside the paragraphs."
        "To use when processing OCR extractor with extract_words().",
        json_schema_extra={"x-category": "core"},
    )
    word_from_line: bool = Field(
        default=False,
        description="Whether to draw the words bbox inside the lines."
        "To use when processing OCR extractor with extract_lines().",
        json_schema_extra={"x-category": "core"},
    )
    draw_ocr_index: bool = Field(
        default=False,
        description="Whether to draw the OCR index of the words."
        "Index goes from 0 to N for each page of an OCR Layout."
        "Index goes from 0 to N for each Paragraphs of a Paragraphs Layout.",
        json_schema_extra={"x-category": "advanced"},
    )
    ocr_index_step: int = Field(
        default=10,
        description="Step to draw the OCR index of the words.<br>"
        "10: Draw the OCR index of the words every 10 words.<br>"
        "5: Draw the OCR index of the words every 5 words.",
        json_schema_extra={"x-category": "advanced"},
    )
    extended_bbox: bool = Field(
        default=False,
        description="Whether to draw the extended bounding box of the elements.",
    )
