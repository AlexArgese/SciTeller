"""Document parsing elements schemas"""

from abc import ABC
from enum import Enum
from itertools import takewhile
import logging
import typing as _t
import numpy as np
from pydantic import (
    BaseModel,
    Field,
    model_validator,
    RootModel,
    ValidationError,
    field_serializer,
)
from ..latex_table import (
    make_flat_table,
    flat_table_to_latex,
)
from ..exceptions import CoordinatesError

logger = logging.getLogger(__name__)


class Extractor(str, Enum):
    """Enum for the origin of the extraction"""

    DOCTR = "doctr"
    PDFPLUMBER = "pdfplumber"
    DETECTRON2 = "detectron2"
    TATR = "tatr"
    YOLO = "yolov10"


class ElementType(str, Enum):
    """Enum for the type of extraction"""

    WORD = "word"
    LINE = "line"
    CELL = "cell"
    TABLE = "table"
    TABLE_CONTENT = "tableContent"
    TEXT = "text"
    LIST = "list"
    TITLE = "title"
    EXTRA = "extra"
    HEADER = "header"
    FOOTER = "footer"
    IMAGE = "image"
    VISUAL_ELEMENT = "visualElement"


ClampedFloat: _t.TypeAlias = _t.Annotated[float, Field(strict=True, ge=0, le=1)]


class Bbox(BaseModel):
    """
    Represents the bounding box of an element in the document layout.

    Attributes
    ----------
    x0 : float
        The x-coordinate of the top-left corner of the bounding box.
    x1 : float
        The x-coordinate of the bottom-right corner of the bounding box.
    y0 : float
        The y-coordinate of the top-left corner of the bounding box.
    y1 : float
        The y-coordinate of the bottom-right corner of the bounding box.
    """

    x0: ClampedFloat
    x1: ClampedFloat
    y0: ClampedFloat
    y1: ClampedFloat

    @model_validator(mode="before")
    def validate_clamped(cls, values: dict[str, _t.Any]) -> dict[str, _t.Any]:  # pylint: disable=E0213
        """Clamp the bounding box values to be within 0 and 1,
        with a tolerance for floating-point precision."""
        epsilon = 1e-2  # Small tolerance level for floating-point precision
        # List of keys to process
        for key in ["x0", "x1", "y0", "y1"]:
            # Clamp values slightly greater than 1 or slightly less than 0
            if 1 < values[key] < 1 + epsilon:
                values[key] = 1
            elif -epsilon < values[key] < 0:
                values[key] = 0
        return values

    @model_validator(mode="after")
    def validate_ccc(self) -> _t.Self:
        """Validate bounding box"""
        if not self.x0 < self.x1:
            raise CoordinatesError(f"x0 ({self.x0}) must be less than x1 ({self.x1})")
        if not self.y0 < self.y1:
            raise CoordinatesError(f"y0 ({self.y0}) must be less than y1 ({self.y1})")
        return self

    @classmethod
    def create(cls, **kwargs: _t.Any) -> _t.Self | None:
        """
        Factory method to create an instance of Bbox.
        Returns None if validation fails due to CoordinatesError
        or ValidationError about the bounding box.
        All other validation errors are raised.
        """
        try:
            return cls(**kwargs)
        except CoordinatesError as e:
            logger.debug("Skip creating %s: %s", cls.__name__, e)
            return None
        except ValidationError as e:
            for error in e.errors():
                logger.debug("Skip creating %s: %s", cls.__name__, error)
                if error["type"] not in ["less_than_equal", "greater_than_equal"]:
                    raise e
            return None

    @property
    def area(self) -> float:
        """Calculate the area of the bounding box"""
        return (self.x1 - self.x0) * (self.y1 - self.y0)


class Element(Bbox):
    """
    Represents a generic element in the document.

    Attributes
    ----------
    x0 : float
        The x-coordinate of the top-left corner of the bounding box.
    x1 : float
        The x-coordinate of the bottom-right corner of the bounding box.
    y0 : float
        The y-coordinate of the top-left corner of the bounding box.
    y1 : float
        The y-coordinate of the bottom-right corner of the bounding box.
    type : str
        The type of the element (e.g., word, line, cell, table).
    metadata : dict[str, _t.Any]
        Additional metadata associated with the element.
    """

    metadata: dict[str, _t.Any] = Field(default_factory=lambda: {})

    @model_validator(mode="before")
    def extras_to_metadata(cls, values: dict[str, _t.Any]) -> dict[str, _t.Any]:  # pylint: disable=E0213
        """Move extra keys to metadata"""
        values.setdefault("metadata", {})
        extra_keys = set(values.keys()) - set(cls.model_fields)
        for key in extra_keys:
            if key in values["metadata"]:
                raise ValueError(f"Duplicate key {key}")
            values["metadata"][key] = values.pop(key)
        return values

    @field_serializer("metadata")
    def serialize_metadata(self, metadata: dict[str, _t.Any]):
        """Serialize metadata"""
        for key, value in metadata.items():
            if isinstance(value, np.floating):
                metadata[key] = float(value)
        return metadata

    def get_bboxes(
        self, as_tuple: bool = False
    ) -> list[Bbox] | list[tuple[float, float, float, float]]:
        """Get bboxes from metadata,
        the bbox of the element himself and the bbox of merged elements
        as_tuple: if True, return a list of tuples instead of Bbox objects"""
        if as_tuple:
            return [(bbox.x0, bbox.y0, bbox.x1, bbox.y1) for bbox in self.bboxes]
        return self.bboxes

    @property
    def extended_x0(self) -> float:
        """Get the extended x0 coordinate of the bounding box if specified in metadata
        used in detect_columns() to extend the bounding box of Title Elements to the element below
        metadata["extended_x"] is a list of two floats [extended_x0, extended_x1]"""
        if extended_x := self.metadata.get("extended_x", None):
            return extended_x[0]
        return self.x0

    @property
    def extended_x1(self) -> float:
        """Get the extended x0 coordinate of the bounding box if specified in metadata
        used in detect_columns() to extend the bounding box of Title Elements to the element below
        metadata["extended_x"] is a list of two floats [extended_x0, extended_x1]"""
        if extended_x := self.metadata.get("extended_x", None):
            return extended_x[1]
        return self.x1

    @property
    def is_content_class(self) -> bool:
        """Check if the element is a content class"""
        return isinstance(self, CONTENT_CLASS_TYPES)

    @property
    def confidence(self) -> float | None:
        """Get confidence from metadata"""
        return self.metadata.get("confidence", None)  # pylint: disable=E1101

    @property
    def label(self) -> str | None:
        """Get label from metadata"""
        return self.metadata.get("label", None)  # pylint: disable=E1101

    @property
    def id(self) -> str:
        """Get id from metadata"""
        return self.metadata.get("id", "")  # pylint: disable=E1101

    @property
    def inferred(self) -> bool:
        """Get inferred from metadata"""
        return self.metadata.get("inferred", False)  # pylint: disable=E1101

    @property
    def vertical(self) -> bool:
        """Get vertical from metadata"""
        return self.metadata.get("vertical", False)  # pylint: disable=E1101

    @property
    def page(self) -> int | None:
        """Get main page of the element from metadata"""
        return self.metadata.get("page", None)  # pylint: disable=E1101

    @property
    def pages(self) -> list[int]:
        """Get pages from metadata,
        the page of the element himself and the page of merged elements"""
        if "pages" in self.metadata:
            return self.metadata["pages"]
        return [self.page] if self.page is not None else []

    @property
    def bboxes(self) -> list[Bbox]:
        """Get bboxes from metadata,
        the bbox of the element himself and the bbox of merged elements"""
        if "bboxes" in self.metadata:
            return self.metadata["bboxes"]
        bbox = Bbox.create(
            x0=self.x0,
            x1=self.x1,
            y0=self.y0,
            y1=self.y1,
        )
        return [bbox] if bbox is not None else []

    @property
    def extractor(
        self,
    ) -> (
        _t.Literal[
            Extractor.DETECTRON2,
            Extractor.DOCTR,
            Extractor.PDFPLUMBER,
            Extractor.TATR,
            Extractor.YOLO,
        ]
        | None
    ):
        """Get extractor from metadata"""
        return self.metadata.get("extractor", None)  # pylint: disable=E1101


class VisualElement(Element):
    """Base class for visual elements in the document.

    Attributes
    ----------
    x0 : float
        The x-coordinate of the top-left corner of the bounding box.
    y0 : float
        The y-coordinate of the top-left corner of the bounding box.
    x1 : float
        The x-coordinate of the bottom-right corner of the bounding box.
    y1 : float
        The y-coordinate of the bottom-right corner of the bounding box.
    type : Literal['visualElement']
        The type of the element, which is 'visualElement'.
    metadata : dict[str, _t.Any]
        Additional metadata associated with the element.
    """

    type: _t.Literal[ElementType.VISUAL_ELEMENT] = Field(
        default=ElementType.VISUAL_ELEMENT
    )


class Word(Element):
    """
    Represents a word in the document.

    Attributes
    ----------
    x0 : float
        The x-coordinate of the top-left corner of the bounding box.
    x1 : float
        The x-coordinate of the bottom-right corner of the bounding box.
    y0 : float
        The y-coordinate of the top-left corner of the bounding box.
    y1 : float
        The y-coordinate of the bottom-right corner of the bounding box.
    type : Literal['word']
        The type of the element, which is 'word'.
    content : str
        The content of the word.
    metadata : dict[str, _t.Any]
        Additional metadata associated with the element.
    """

    type: _t.Literal[ElementType.WORD] = Field(default=ElementType.WORD)
    content: str = Field(default="")

    @property
    def is_bold(self) -> bool:
        """Check if the word is bold based on the font name."""
        font = self.metadata.get("fontname", "").split("+")[-1]
        return any(keyword in font for keyword in ["Bold", "Black"])

    @property
    def is_italic(self) -> bool:
        """Check if the word is italic based on the font name."""
        font = self.metadata.get("fontname", "").split("+")[-1]
        return any(keyword in font for keyword in ["Italic", "Oblique", "Slanted"])

    def to_str(self) -> str:
        """Return the string representation of the word"""
        return self.content


class Line(Element):
    """
    Represents a line of text in the document.

    Attributes
    ----------
    x0 : float
        The x-coordinate of the top-left corner of the bounding box.
    x1 : float
        The x-coordinate of the bottom-right corner of the bounding box.
    y0 : float
        The y-coordinate of the top-left corner of the bounding box.
    y1 : float
        The y-coordinate of the bottom-right corner of the bounding box.
    type : Literal['line']
        The type of the element, which is 'line'.
    content : list[Word]
        A list of words that make up the line.
    metadata : dict[str, _t.Any]
        Additional metadata associated with the element.
    """

    type: _t.Literal[ElementType.LINE] = Field(default=ElementType.LINE)
    content: list[Word] = Field(default_factory=list)

    def _word_match_with_line(self, word: Word, i: int) -> bool:
        """Check if the word is consistent with the line
        meaning that the word matches intervals of each word in the line
        x intervals if the line is vertical and y intervals otherwise"""
        if all(w.metadata.get("vertical", None) for w in self.content):
            for other_word in self.content[i + 1 :]:
                if word.x1 < other_word.x0 or word.x0 > other_word.x1:
                    logger.warning(
                        "Words '%s' and '%s' are not consistent in the same line : '%s'",
                        word.content,
                        other_word.content,
                        self.to_str(),
                    )
                    return False
        else:
            for other_word in self.content[i + 1 :]:
                if word.y1 < other_word.y0 or word.y0 > other_word.y1:
                    logger.warning(
                        "Words '%s' and '%s' are not consistent in the same line : '%s'",
                        word.content,
                        other_word.content,
                        self.to_str(),
                    )
                    return False
        return True

    @model_validator(mode="after")
    def check_line_consistency(self) -> _t.Self:
        """Check if all words in the line match themselves"""
        for i, word in enumerate(self.content):
            if not self._word_match_with_line(word, i):
                break
        return self

    def to_str(self) -> str:
        """Return the string representation of the line"""
        return " ".join([word.content for word in self.content])


class Cell(Element):
    """
    Represents a cell in a table within the document.

    Attributes
    ----------
    x0 : float
        The x-coordinate of the top-left corner of the bounding box.
    x1 : float
        The x-coordinate of the bottom-right corner of the bounding box.
    y0 : float
        The y-coordinate of the top-left corner of the bounding box.
    y1 : float
        The y-coordinate of the bottom-right corner of the bounding box.
    type : Literal['cell']
        The type of the element, which is 'cell'.
    metadata : dict[str, _t.Any]
        Additional metadata associated with the element.
    """

    type: _t.Literal[ElementType.CELL] = Field(default=ElementType.CELL)


class Table(Element):
    """
    Represents a table in the document.

    Attributes
    ----------
    x0 : float
        The x-coordinate of the top-left corner of the bounding box.
    x1 : float
        The x-coordinate of the bottom-right corner of the bounding box.
    y0 : float
        The y-coordinate of the top-left corner of the bounding box.
    y1 : float
        The y-coordinate of the bottom-right corner of the bounding box.
    type : Literal['table']
        The type of the element, which is 'table'.
    cells : list[Cell] | None
        A list of cells in the table or None if there are no cells.
    metadata : dict[str, _t.Any]
        Additional metadata associated with the element.
    """

    type: _t.Literal[ElementType.TABLE] = Field(default=ElementType.TABLE)
    cells: list[Cell] | None = None


class TableContent(Table):
    """
    Represents the content of a table in the document.

    Attributes
    ----------
    x0 : float
        The x-coordinate of the top-left corner of the bounding box.
    x1 : float
        The x-coordinate of the bottom-right corner of the bounding box.
    y0 : float
        The y-coordinate of the top-left corner of the bounding box.
    y1 : float
        The y-coordinate of the bottom-right corner of the bounding box.
    type : Literal['table']
        The type of the element, which is 'table'.
    cells : list[Cell] | None
        A list of cells in the table or None if there are no cells.
    headers : list[str] | None
        A list of headers for the table or None if there are no headers.
    indexes : list[str] | None
        A list of indexes associated with the table or None if there are none.
    content : list[list[str]]
        The content of the table.
    metadata : dict[str, _t.Any]
        Additional metadata associated with the element.
    """

    type: _t.Literal[ElementType.TABLE_CONTENT] = Field(
        default=ElementType.TABLE_CONTENT
    )
    headers: list[str] | None = None
    indexes: list[str] | None = None
    content: list[list[str]] = Field(default_factory=list)

    @property
    def nb_columns(self) -> int:
        """Get the number of columns in the table"""
        if not self.content:
            logger.warning(
                "Table content is empty, cannot get number of columns (page: %s)",
                self.page,
            )
            return 0
        return len(self.content[0])

    @property
    def first_row_is_header(self) -> bool:
        """Check if the first row of the table is a header"""
        if not self.content or not self.cells:
            logger.warning(
                "Table content or cells list is empty, "
                "cannot check if first row is header (page: %s)",
                self.page,
            )
            return False
        return all(
            cell.label in ["spanning_header", "cell_header"]
            for cell in self.cells[: self.nb_columns]
        )

    def get_spanning_cells(self) -> tuple[dict[int, tuple[int, int]], list[int]]:
        """Get spanning cells from a list of cells
        return a tuple :
        - dict with cell index as key and (rowspan, colspan) as value
        - list of cell index to skip
        """
        spanning_cells: dict[int, tuple[int, int]] = {}
        already_processed: list[Cell] = []
        skip_pos: list[int] = []
        if self.cells is None:
            logger.warning(
                "Table has no cells, cannot get spanning cells (page: %s)", self.page
            )
            return {}, []
        for pos, cell in enumerate(self.cells):
            # add rest of the spanning cells to skip_pos
            if cell in already_processed:
                skip_pos.append(pos)
            # is a spanning cell and not already processed
            if (
                cell.label in ["spanning_cell", "spanning_header"]
                and cell not in already_processed
            ):
                # set rowspan depending on how many consecutive times the cell is in the list
                colspan = 1 + sum(
                    1 for _ in takewhile(lambda x: x == cell, self.cells[pos + 1 :])
                )
                # count how many times the cell is in the list
                nb_cell_iter = self.cells.count(cell)
                # spanning cell are rectangular so nb_cell_iter must be divisible by colspan
                if nb_cell_iter % colspan != 0:
                    logger.warning(
                        "Spanning Cell is not rectangular, table may be corrupted (page: %s)",
                        self.page,
                    )
                rowspan = (
                    int(nb_cell_iter / colspan) if nb_cell_iter % colspan == 0 else 1
                )
                spanning_cells[pos] = (rowspan, colspan)
                already_processed.append(cell)
        return spanning_cells, skip_pos

    def to_latex(self) -> str:
        """Return the LaTeX representation of the table content"""
        list_spanning_cells, skip_idx = self.get_spanning_cells()
        flat_table = make_flat_table(list_spanning_cells, skip_idx, self.content)
        latex_table = flat_table_to_latex(flat_table)
        return latex_table

    def to_str(self) -> str:
        """Return the string representation of the table content"""
        table_content: list[list[str]] = self.content
        if self.headers is not None:
            table_content = [self.headers] + self.content
        if self.indexes is not None:
            table_content: list[list[str]] = [
                [index] + row
                for index, row in zip(self.indexes, table_content, strict=True)
            ]
        return "\n".join([" | ".join(row) for row in table_content])

    def merge_element(self, other: _t.Self) -> None:
        """Merge the content of another element into this one"""
        if not isinstance(other, type(self)):
            logger.error("Cannot merge %s into %s", type(other), type(self))
            return
        self.cells = (
            self.cells + other.cells
            if self.cells is not None and other.cells is not None
            else None
        )
        self.content.extend(other.content)
        if elem_bbox := Bbox.create(x0=self.x0, y0=self.y0, x1=self.x1, y1=self.y1):
            # set both or none to ensure pages and bboxes are the same length
            self.metadata.setdefault("pages", [self.page])
            self.metadata.setdefault("bboxes", [elem_bbox])

        if next_elem_bbox := Bbox.create(
            x0=other.x0, y0=other.y0, x1=other.x1, y1=other.y1
        ):
            # append both or none to ensure pages and bboxes are the same length
            self.metadata["pages"].append(other.page)
            self.metadata["bboxes"].append(next_elem_bbox)


class Paragraph(Element, ABC):
    """
    Represents a paragraph in the document.

    Attributes
    ----------
    x0 : float
        The x-coordinate of the top-left corner of the bounding box.
    x1 : float
        The x-coordinate of the bottom-right corner of the bounding box.
    y0 : float
        The y-coordinate of the top-left corner of the bounding box.
    y1 : float
        The y-coordinate of the bottom-right corner of the bounding box.
    type : Literal['text', 'list', 'title', 'header']
        The type of the element
    content : list[Word]
        A list of words that make up the paragraph.
    metadata : dict[str, _t.Any]
        Additional metadata associated with the element.
    """

    content: list[Word] = Field(default_factory=list)

    @property
    def is_vertical(self) -> bool:
        """Check if the paragraph is vertical"""
        if not self.content:
            return False
        return all(word.metadata.get("vertical", False) for word in self.content)

    def to_str(self) -> str:
        """Return the string representation of the paragraph"""
        return " ".join([word.content for word in self.content])

    def merge_element(self, other: _t.Self) -> None:
        """Merge the content of another element into this one
        and update the metadata accordingly."""
        if not isinstance(other, type(self)):
            logger.error("Cannot merge %s into %s", type(other), type(self))
            return
        self.content.extend(other.content)
        if elem_bbox := Bbox.create(x0=self.x0, y0=self.y0, x1=self.x1, y1=self.y1):
            # set both or none to ensure pages and bboxes are the same length
            self.metadata.setdefault("pages", [self.page])
            self.metadata.setdefault("bboxes", [elem_bbox])

        if next_elem_bbox := Bbox.create(
            x0=other.x0, y0=other.y0, x1=other.x1, y1=other.y1
        ):
            # append both or none to ensure pages and bboxes are the same length
            self.metadata["pages"].append(other.page)
            self.metadata["bboxes"].append(next_elem_bbox)


class Text(Paragraph):
    """Represents a text paragraph in the document.

    Attributes
    ----------
    x0 : float
        The x-coordinate of the top-left corner of the bounding box.
    x1 : float
        The x-coordinate of the bottom-right corner of the bounding box.
    y0 : float
        The y-coordinate of the top-left corner of the bounding box.
    y1 : float
        The y-coordinate of the bottom-right corner of the bounding box.
    type : Literal['text']
        The type of the element, which is 'text'.
    content : list[Word]
        A list of words that make up the paragraph.
    metadata : dict[str, _t.Any]
        Additional metadata associated with the element.
    """

    type: _t.Literal[ElementType.TEXT] = Field(default=ElementType.TEXT)


class List(Paragraph):
    """Represents a list paragraph in the document.

    Attributes
    ----------
    x0 : float
        The x-coordinate of the top-left corner of the bounding box.
    x1 : float
        The x-coordinate of the bottom-right corner of the bounding box.
    y0 : float
        The y-coordinate of the top-left corner of the bounding box.
    y1 : float
        The y-coordinate of the bottom-right corner of the bounding box.
    type : Literal['list']
        The type of the element, which is 'list'.
    content : list[Word]
        A list of words that make up the paragraph.
    metadata : dict[str, _t.Any]
        Additional metadata associated with the element.
    """

    type: _t.Literal[ElementType.LIST] = Field(default=ElementType.LIST)

    def to_list(self) -> list[list[Word]]:
        """convert content to a list of lists using metadata"""
        item_start = self.metadata.get("item_idx", [])
        desc_start = self.metadata.get("desc_idx", [])
        split_index = sorted(item_start + desc_start)
        list_content: list[list[Word]] = []
        for i, j in zip([0] + split_index, split_index + [None]):
            if self.content[i:j]:
                list_content.append(self.content[i:j])
        return list_content

    def merge_element(self, other: _t.Self) -> None:
        """Merge the content of another element into this one"""
        if not isinstance(other, type(self)):
            logger.error("Cannot merge %s into %s", type(other), type(self))
            return
        # add item and desc index to the first element with an offset
        if "item_idx" in self.metadata and "item_idx" in other.metadata:
            word_offset = len(self.content)
            self.metadata["item_idx"].extend(
                [i + word_offset for i in other.metadata["item_idx"]]
            )
            self.metadata["desc_idx"].extend(
                [i + word_offset for i in other.metadata["desc_idx"]]
            )
        # add content to the first element
        self.content.extend(other.content)
        if elem_bbox := Bbox.create(x0=self.x0, y0=self.y0, x1=self.x1, y1=self.y1):
            # set both or none to ensure pages and bboxes are the same length
            self.metadata.setdefault("pages", [self.page])
            self.metadata.setdefault("bboxes", [elem_bbox])

        if next_elem_bbox := Bbox.create(
            x0=other.x0, y0=other.y0, x1=other.x1, y1=other.y1
        ):
            # append both or none to ensure pages and bboxes are the same length
            self.metadata["pages"].append(other.page)
            self.metadata["bboxes"].append(next_elem_bbox)


class Title(Paragraph):
    """Represents a title paragraph in the document.

    Attributes
    ----------
    x0 : float
        The x-coordinate of the top-left corner of the bounding box.
    x1 : float
        The x-coordinate of the bottom-right corner of the bounding box.
    y0 : float
        The y-coordinate of the top-left corner of the bounding box.
    y1 : float
        The y-coordinate of the bottom-right corner of the bounding box.
    type : Literal['title']
        The type of the element, which is 'title'.
    content : list[Word]
        A list of words that make up the paragraph.
    metadata : dict[str, _t.Any]
        Additional metadata associated with the element.
    """

    type: _t.Literal[ElementType.TITLE] = Field(default=ElementType.TITLE)


class Extra(Paragraph):
    """Represents an Extra paragraph in the document.

    Attributes
    ----------
    x0 : float
        The x-coordinate of the top-left corner of the bounding box.
    x1 : float
        The x-coordinate of the bottom-right corner of the bounding box.
    y0 : float
        The y-coordinate of the top-left corner of the bounding box.
    y1 : float
        The y-coordinate of the bottom-right corner of the bounding box.
    type : Literal['extra']
        The type of the element, which is 'extra'.
    content : list[Word]
        A list of words that make up the paragraph.
    metadata : dict[str, _t.Any]
        Additional metadata associated with the element."""

    type: _t.Literal[ElementType.EXTRA] = Field(default=ElementType.EXTRA)


class Header(Extra):
    """Represents a header paragraph in the document.

    Attributes
    ----------
    x0 : float
        The x-coordinate of the top-left corner of the bounding box.
    x1 : float
        The x-coordinate of the bottom-right corner of the bounding box.
    y0 : float
        The y-coordinate of the top-left corner of the bounding box.
    y1 : float
        The y-coordinate of the bottom-right corner of the bounding box.
    type : Literal['header']
        The type of the element, which is 'header'.
    content : list[Word]
        A list of words that make up the paragraph.
    metadata : dict[str, _t.Any]
        Additional metadata associated with the element."""

    type: _t.Literal[ElementType.HEADER] = Field(default=ElementType.HEADER)


class Footer(Extra):
    """Represents a footer paragraph in the document.

    Attributes
    ----------
    x0 : float
        The x-coordinate of the top-left corner of the bounding box.
    x1 : float
        The x-coordinate of the bottom-right corner of the bounding box.
    y0 : float
        The y-coordinate of the top-left corner of the bounding box.
    y1 : float
        The y-coordinate of the bottom-right corner of the bounding box.
    type : Literal['footer']
        The type of the element, which is 'footer'.
    content : list[Word]
        A list of words that make up the paragraph.
    metadata : dict[str, _t.Any]
        Additional metadata associated with the element."""

    type: _t.Literal[ElementType.FOOTER] = Field(default=ElementType.FOOTER)


class Image(Paragraph):
    """Represents an image paragraph in the document.

    Attributes
    ----------
    x0 : float
        The x-coordinate of the top-left corner of the bounding box.
    x1 : float
        The x-coordinate of the bottom-right corner of the bounding box.
    y0 : float
        The y-coordinate of the top-left corner of the bounding box.
    y1 : float
        The y-coordinate of the bottom-right corner of the bounding box.
    type : Literal['image']
        The type of the element, which is 'image'.
    content : list[Word]
        A list of words that make up the paragraph.
    metadata : dict[str, _t.Any]
        Additional metadata associated with the element."""

    type: _t.Literal[ElementType.IMAGE] = Field(default=ElementType.IMAGE)


AutoParagraphElement: _t.TypeAlias = _t.Annotated[
    Text | List | Title | Extra | Header | Footer | Image,
    Field(discriminator="type"),
]
AutoPlayoutElement: _t.TypeAlias = _t.Annotated[
    TableContent
    | Table
    | Text
    | List
    | Title
    | Extra
    | Header
    | Footer
    | Image
    | VisualElement,
    Field(discriminator="type"),
]
AutoLlayoutElement: _t.TypeAlias = _t.Annotated[
    Line | VisualElement,
    Field(discriminator="type"),
]
AutoWlayoutElement: _t.TypeAlias = _t.Annotated[
    Word | VisualElement,
    Field(discriminator="type"),
]
AutoLayoutElement: _t.TypeAlias = _t.Annotated[
    TableContent
    | Table
    | Text
    | List
    | Title
    | Extra
    | Header
    | Footer
    | Image
    | Word
    | Line
    | VisualElement,
    Field(discriminator="type"),
]
AutoElement: _t.TypeAlias = _t.Annotated[
    Word
    | Line
    | Cell
    | TableContent
    | Table
    | Text
    | List
    | Title
    | Extra
    | Header
    | Footer
    | Image
    | VisualElement,
    Field(discriminator="type"),
]

CONTENT_CLASS_TYPES = (Paragraph, Word, Line, TableContent)

T = _t.TypeVar(
    "T",
    Word | VisualElement,
    Line | VisualElement,
    TableContent
    | Table
    | Text
    | List
    | Title
    | Extra
    | Header
    | Footer
    | Image
    | VisualElement,
)


class Layout(RootModel[T], _t.Generic[T]):
    """
    Represents the layout of elements in the document.
    It can be used to represent different types of layouts:
    OCR Layout :
        - Layout of Words and Visual Elements
        - Layout of Lines and Visual Elements
    Layout :
        - Layout of Tables and Paragraphs


    Attributes
    ----------
    elements : list[T]
        A list of elements that make up the layout.

    Methods
    -------
    tables: Filter tables from elements
    page_count: Get page count
    get_elements_by_page: Retrieve elements by page
    sort_by_bbox: Sort elements by page and bbox
    sort_by_page: Sort elements by page
    remove_table: Remove table elements
    filter_empty_elements: Filter elements with empty content
    to_str: Convert layout to string format
    """

    root: list[T] = Field(default_factory=list)

    @model_validator(mode="after")
    def _validate_elements_type(self) -> _t.Self:
        """Validate elements type"""
        if not (
            all(
                elem.type in [ElementType.WORD, ElementType.VISUAL_ELEMENT]
                for elem in self.root
            )
            or all(
                elem.type in [ElementType.LINE, ElementType.VISUAL_ELEMENT]
                for elem in self.root
            )
            or all(
                elem.type
                in [
                    ElementType.TABLE_CONTENT,
                    ElementType.TABLE,
                    ElementType.TEXT,
                    ElementType.LIST,
                    ElementType.TITLE,
                    ElementType.EXTRA,
                    ElementType.HEADER,
                    ElementType.FOOTER,
                    ElementType.IMAGE,
                    ElementType.VISUAL_ELEMENT,
                ]
                for elem in self.root
            )
        ):
            raise ValueError(
                "Elements must be either All words and visual elements, All lines and visual elements, All tables and paragraphs"
            )
        return self

    @property
    def tables(self) -> _t.Sequence[Table]:
        """Filter tables from elements"""
        return [el for el in self.root if isinstance(el, Table)]

    @property
    def words(self) -> _t.Sequence[Word]:
        """Filter words from elements"""
        return [el for el in self.root if isinstance(el, Word)]

    @property
    def images(self) -> _t.Sequence[Image]:
        """Filter images from elements"""
        return [el for el in self.root if isinstance(el, Image)]

    @property
    def page_count(self) -> int:
        """Get page count"""
        return max(
            (elem.page + 1 for elem in self.root if elem.page is not None),
            default=0,
        )

    def __iadd__(self, elements: T | list[T]) -> _t.Self:
        """Allow in-place addition with += to append elements to layout."""
        if isinstance(elements, list):
            self.root.extend(elements)
        else:
            self.root.append(elements)
        return self

    def get_visual_elements(
        self, pop_visual_elements: bool = False
    ) -> list[VisualElement]:
        """Filter visual elements from elements."""
        visual_elements: list[VisualElement] = [
            el for el in self.root if isinstance(el, VisualElement)
        ]
        if pop_visual_elements:
            self.root = [el for el in self.root if not isinstance(el, VisualElement)]
        return visual_elements

    def get_tables(self, pop_tables: bool = False) -> list[Table]:
        """Filter tables from elements, optionally popping them."""
        tables: list[Table] = [el for el in self.root if isinstance(el, Table)]
        if pop_tables:
            self.root = [el for el in self.root if not isinstance(el, Table)]
        return tables

    def get_elements_by_extractor(
        self, extractor: Extractor, pop_elements: bool = False
    ) -> list[T]:
        """Retrieve elements by extractor"""
        elements = [elem for elem in self.root if elem.extractor == extractor]
        if pop_elements:
            self.root = [elem for elem in self.root if elem.extractor != extractor]
        return elements

    def get_elements_by_page(self, page: int, from_pages: bool = False) -> list[T]:
        """Retrieve elements by page."""
        if from_pages:
            return [elem for elem in self.root if page in elem.pages]
        return [elem for elem in self.root if elem.page == page]

    @property
    def iterate_elements_by_page(self) -> _t.Generator[list[T], None, None]:
        """Iterate elements by page"""
        for page in range(self.page_count):
            yield self.get_elements_by_page(page)

    def sort_by_bbox(self) -> _t.Self:
        """Sort elements by page and bbox"""
        self.root = sorted(self.root, key=lambda x: (x.page, x.y1, x.x1))
        return self

    def sort_by_page(self) -> _t.Self:
        """Sort elements by page"""
        self.root = sorted(
            self.root, key=lambda x: x.page if x.page is not None else -1
        )
        return self

    def replace_element(self, element: AutoElement, new_element: AutoElement) -> None:
        """Replace element in layout"""
        self.root[self.root.index(element)] = new_element

    def remove_table(self) -> _t.Self:
        """Remove table elements"""
        self.root = [
            elem
            for elem in self.root
            if elem.type not in [ElementType.TABLE, ElementType.TABLE_CONTENT]
        ]
        return self

    def filter_empty_elements(self, keep_empty_image: bool = True) -> _t.Self:
        """Filter elements with empty content"""
        self.root = [
            elem
            for elem in self.root
            if elem.type in [ElementType.VISUAL_ELEMENT]
            or (keep_empty_image and elem.type == ElementType.IMAGE)
            or (elem.type not in [ElementType.TABLE, ElementType.CELL] and elem.content)
        ]
        return self

    def to_str(self) -> str:
        """Convert layout to string format"""
        return "\n\n".join(
            [
                element.to_str()
                for element in self.root
                # class with content meanwhile with .to_str() method
                if isinstance(element, CONTENT_CLASS_TYPES)
            ]
        )


WLayout: _t.TypeAlias = Layout[AutoWlayoutElement]
LLayout: _t.TypeAlias = Layout[AutoLlayoutElement]
PLayout: _t.TypeAlias = Layout[AutoPlayoutElement]
