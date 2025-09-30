"""Visualization module for drawing layout on image"""

from typing import Sequence
import io
import os
import logging
from PIL import Image, ImageDraw, ImageFont

from .utils import pdf_to_pil_images
from .schemas import (
    PLayout,
    WLayout,
    LLayout,
    ElementType,
    Word,
    Line,
    Paragraph,
    Table,
    TableContent,
    Cell,
    VisualElement,
    AutoElement,
    AutoParagraphElement,
)

logger = logging.getLogger(__name__)

COLOR_DICT = {
    "yellow": (255, 255, 0),
    "red": (255, 0, 0),
    "light_red": (255, 99, 71),
    "green": (0, 255, 0),
    "forest": (34, 139, 34),
    "blue": (0, 0, 255),
    "white": (255, 255, 255),
    "black": (0, 0, 0),
    "purple": (255, 0, 255),
    "dark_purple": (128, 0, 128),
    "dark_pink": (255, 105, 180),
    "orange": (255, 165, 0),
    "pink": (255, 20, 147),
    "brown": (165, 42, 42),
    "grey": (192, 192, 192),
    "cyan": (0, 255, 255),
    "light_blue": (173, 216, 230),
}

# COLOR for each ElementType using color name
COLORS = {
    ElementType.WORD.value: COLOR_DICT["yellow"],
    ElementType.LINE.value: COLOR_DICT["orange"],
    ElementType.TEXT.value: COLOR_DICT["red"],
    ElementType.TITLE.value: COLOR_DICT["blue"],
    ElementType.LIST.value: COLOR_DICT["cyan"],
    ElementType.EXTRA.value: COLOR_DICT["light_red"],
    ElementType.HEADER.value: COLOR_DICT["light_red"],
    ElementType.FOOTER.value: COLOR_DICT["light_red"],
    ElementType.IMAGE.value: COLOR_DICT["brown"],
    ElementType.CELL.value: COLOR_DICT["purple"],
    ElementType.TABLE.value: COLOR_DICT["forest"],
    ElementType.TABLE_CONTENT.value: COLOR_DICT["green"],
    ElementType.VISUAL_ELEMENT.value: COLOR_DICT["light_blue"],
    "columns": COLOR_DICT["blue"],
    "inferred": COLOR_DICT["black"],
    "spanning_cell": COLOR_DICT["dark_purple"],
    "cell_header": COLOR_DICT["dark_pink"],
    "spanning_header": COLOR_DICT["pink"],
    "word_idx": COLOR_DICT["pink"],
}
DEFAULT_FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
ELEMENT_THICKNESS = {"spanning_cell": 5, "cell_header": 5, "spanning_header": 5}
THICKNESS = 4
FONT_SIZE = 50
LABEL_SHIFT = 50


def get_corners(
    element: AutoElement, image: Image.Image, page: int, extended_bbox: bool = False
) -> tuple[tuple[int, int], tuple[int, int]]:
    """Get bounding box of element"""
    width, height = image.size
    for elem_page, bbox in zip(element.pages, element.bboxes):
        if elem_page == page:
            if extended_bbox:
                # Use the extended bbox on X
                return (
                    (int(element.extended_x0 * width), int(bbox.y0 * height)),
                    (int(element.extended_x1 * width), int(bbox.y1 * height)),
                )
            return (int(bbox.x0 * width), int(bbox.y0 * height)), (
                int(bbox.x1 * width),
                int(bbox.y1 * height),
            )
    # Fallback to element bbox if no bbox found in bboxes for the given page (should never happen)
    logger.warning(
        "No bbox found for page %d in element of type %s, using element bbox",
        page,
        element.type.value,
    )
    return (int(element.x0 * width), int(element.y0 * height)), (
        int(element.x1 * width),
        int(element.y1 * height),
    )


def get_label_position(
    top_left: tuple[float, float], label_shift: int
) -> tuple[float, float]:
    """Get label position"""
    label_x: float = top_left[0]
    label_y: float = (
        top_left[1] - label_shift
        if top_left[1] - label_shift > 0
        else top_left[1] + label_shift
    )  # Avoid going out of bounds
    return (label_x, label_y)


def make_label(element: AutoElement, position: int, add_confidence: bool) -> str:
    """Make label from element"""
    label = str(position)
    label += "_" + element.type.value
    if element.inferred:
        label += "_inferred"
    if add_confidence and element.confidence is not None:
        label += "_" + str(round(element.confidence, 2))
    return label


class Visualization:
    """Class to draw layout bbox and metadatas on image

    Parameters:
    ----------
    image_dpi: int, optional
        DPI of the image, by default 300
    colors: dict, optional
        Colors for each element type, by default None
    thickness: int, optional
        Thickness of the bounding box, by default 2
    draw_cells: bool, optional
        Draw cells, by default True
    label: bool, optional
        Draw label on the bounding box, by default True
    label_confidence: bool, optional
        Draw confidence on the label, by default True
    cell_label: bool, optional
        Draw label on the cell bounding box, by default True
    font: int, optional
        Font type, by default FONT_HERSHEY_SIMPLEX
    font_size: int, optional
        Font scale, by default 50
    label_shift: int, optional
        Shift of label from top left corner, by default 10
    word_from_line: bool, optional
        Draw words from line, by default False
    word_from_paragraph: bool, optional
        Draw words from paragraph, by default False
    columns: bool, optional
        Draw columns, by default False
    draw_ocr_index: bool, optional
        Draw ocr index, by default False
    ocr_index_step: int, optional
        Step of ocr index, by default 10

    Examples:
    ```python
    from docparsing.visualization import Visualization

    # Create visualization object
    visu = Visualization()

    # Draw layout on image
    images = visu.draw_layouts(layout, file_content, pages=[0, 1])
    ```

    """

    def __init__(
        self,
        image_dpi: int = 300,
        grayscale: bool = False,
        colors: dict[str, tuple[int, int, int]] | None = None,
        thickness: int = THICKNESS,
        draw_cells: bool = True,
        label: bool = True,
        label_confidence: bool = True,
        cell_label: bool = True,
        font: str = DEFAULT_FONT,
        font_size: int = FONT_SIZE,
        label_shift: int = LABEL_SHIFT,
        word_from_line: bool = False,
        word_from_paragraph: bool = False,
        columns: bool = False,
        draw_ocr_index: bool = False,
        ocr_index_step: int = 10,
        extended_bbox: bool = False,
    ) -> None:
        self.image_dpi = image_dpi
        self.grayscale = grayscale
        self.colors = colors if colors is not None else COLORS
        self.thickness = thickness
        self.draw_cells = draw_cells
        self.label = label
        self.label_confidence = label_confidence
        self.cell_label = cell_label
        self.font = (
            ImageFont.truetype(font, font_size) if os.path.exists(font) else None
        )
        self.label_shift = label_shift
        self.word_from_line = word_from_line
        self.word_from_paragraph = word_from_paragraph
        self.columns = columns
        self.draw_ocr_index = draw_ocr_index
        self.ocr_index_step = ocr_index_step
        self.extended_bbox = extended_bbox

    def _draw_columns(self, element: AutoElement, image: Image.Image) -> None:
        """Draw columns on image"""
        if self.columns and "columns" in element.metadata:
            width, height = image.size
            for column in element.metadata["columns"]:
                top_left, bottom_right = (
                    (int(column[0] * width), int(column[1] * height)),
                    (
                        int(column[0] * width),
                        int(column[2] * height),
                    ),
                )
                draw = ImageDraw.Draw(image)
                draw.line(
                    [top_left, bottom_right],
                    fill=self.colors["columns"],
                    width=self.thickness,
                )

    def _draw_word(
        self,
        element: Word,
        image: Image.Image,
        page: int,
        word_index: int = 0,
    ) -> None:
        """Draw word on image"""
        if page not in element.pages:
            return
        top_left, bottom_right = get_corners(element, image, page)
        draw = ImageDraw.Draw(image)
        draw.rectangle(
            [top_left, bottom_right],
            outline=self.colors[element.type.value],
            width=self.thickness,
        )
        color = self.colors.get("word_idx", self.colors[element.type.value])
        if self.draw_ocr_index and word_index % self.ocr_index_step == 0:
            draw.text(
                get_label_position(top_left, self.label_shift),
                str(word_index),
                font=self.font,
                fill=color,
            )

    def _draw_line(
        self,
        element: Line,
        image: Image.Image,
        page: int,
        idx_offset: int = 0,
    ) -> int:
        """Draw line on image"""
        if page not in element.pages:
            return 0
        top_left, bottom_right = get_corners(element, image, page)
        draw = ImageDraw.Draw(image)
        draw.rectangle(
            [top_left, bottom_right],
            outline=self.colors[element.type.value],
            width=self.thickness,
        )
        idx_word = 0
        if self.word_from_line:
            for idx_word, word in enumerate(element.content):
                self._draw_word(word, image, page, word_index=idx_word + idx_offset)
        return idx_word

    def _draw_paragraph(
        self,
        element: AutoParagraphElement,
        image: Image.Image,
        position: int,
        page: int,
    ) -> None:
        """Draw paragraph on image"""
        top_left, bottom_right = get_corners(element, image, page, self.extended_bbox)
        color = self.colors.get(
            "inferred" if element.inferred else element.label,
            self.colors[element.type.value],
        )
        thickness = ELEMENT_THICKNESS.get(element.type.value, self.thickness)
        draw = ImageDraw.Draw(image)
        draw.rectangle(
            [top_left, bottom_right],
            outline=color,
            width=thickness,
        )
        if self.label:
            draw.text(
                get_label_position(top_left, self.label_shift),
                make_label(element, position, add_confidence=self.label_confidence),
                font=self.font,
                fill=color,
            )
        if self.word_from_paragraph:
            for idx_word, word in enumerate(element.content):
                self._draw_word(word, image, page, word_index=idx_word)
        self._draw_columns(element, image)

    def _draw_cell(self, element: Cell, image: Image.Image, page: int) -> None:
        """Draw cell on image"""
        if page not in element.pages:
            return
        top_left, bottom_right = get_corners(element, image, page)
        color = self.colors.get(element.label, self.colors[element.type.value])
        thickness = ELEMENT_THICKNESS.get(element.label, self.thickness)

        draw = ImageDraw.Draw(image)
        draw.rectangle(
            [top_left, bottom_right],
            outline=color,
            width=thickness,
        )
        if self.label and self.cell_label:
            draw.text(
                get_label_position(top_left, self.label_shift),
                element.label if element.label is not None else element.type.value,
                font=self.font,
                fill=color,
            )

    def _draw_table(
        self,
        element: Table | TableContent,
        image: Image.Image,
        position: int,
        page: int,
    ) -> None:
        """Draw table on image"""
        top_left, bottom_right = get_corners(element, image, page)
        draw = ImageDraw.Draw(image)
        draw.rectangle(
            [top_left, bottom_right],
            outline=self.colors[element.type.value],
            width=self.thickness,
        )
        if self.label:
            draw.text(
                get_label_position(top_left, self.label_shift),
                make_label(element, position, add_confidence=self.label_confidence),
                font=self.font,
                fill=self.colors[element.type.value],
            )
        if element.cells is not None and self.draw_cells:
            for cell in element.cells:
                self._draw_cell(cell, image, page)

    def _draw_visual_element(
        self,
        element: VisualElement,
        image: Image.Image,
        position: int,
        page: int,
    ) -> None:
        """Draw visual element on image"""
        top_left, bottom_right = get_corners(element, image, page)
        draw = ImageDraw.Draw(image)
        draw.rectangle(
            [top_left, bottom_right],
            outline=self.colors[element.type.value],
            width=self.thickness,
        )
        draw.text(
            get_label_position(top_left, self.label_shift),
            make_label(element, position, add_confidence=self.label_confidence),
            font=self.font,
            fill=self.colors[element.type.value],
        )
        self._draw_columns(element, image)

    def _draw_layout(
        self, layout: list[AutoElement], image: Image.Image, page: int
    ) -> None:
        """Draw layout on image"""
        idx_offset = 0
        for position, element in enumerate(layout):
            if element.type == ElementType.WORD and element.page == page:
                self._draw_word(element, image, page, idx_offset)
                idx_offset += 1
            elif element.type == ElementType.LINE and element.page == page:
                nb_words = self._draw_line(element, image, page, idx_offset)
                idx_offset += nb_words
            elif isinstance(element, Paragraph):
                self._draw_paragraph(element, image, position, page)
            elif isinstance(element, (Table, TableContent)):
                self._draw_table(element, image, position, page)
            elif isinstance(element, VisualElement):
                self._draw_visual_element(element, image, position, page)

    def draw_layouts(
        self,
        *layouts: PLayout | WLayout | LLayout,
        file_content: io.BytesIO | None = None,
        pages: list[int] | None = None,
        page_offset: int = 0,
        full_layout: bool = True,
        out: str | None = None,
    ) -> Sequence[Image.Image]:
        """Draw layouts on image

        Parameters
        ----------
        layouts: PLayout | WLayout | LLayout
            Layouts to draw
        file_content: io.BytesIO
            PDF file content
        pages: list[int], optional
            Pages to draw, by default None
        page_offset: int, optional
            Offset of pages, by default 0
        full_layout: bool, optional
            Layout is based on full document, by default True
            Meanwhile, use page_offset to offset the page number to match the file_content
        out: str, optional
            Output path to save images, by default None

        Returns
        -------
        list[Image]
            List of images with layouts drawn on it
        """
        if file_content is None:
            raise ValueError("file_content must be provided")
        images = pdf_to_pil_images(file_content, self.image_dpi)
        # used to visualize layout on blank page (XP)
        # images = [Image.new("RGB", (2480, 3508), color=(255, 255, 255)) for _ in images]
        if pages is None:
            # 0-indexed pages
            pages = list(range(len(images)))
        elif full_layout:
            # offset pages to 0-indexed to match the images
            pages = [page - page_offset for page in pages]
        # filter out of bound pages
        pages = [page for page in pages if 0 <= page < len(images)]
        for page in pages:
            # offset page to match the correct element.page in layout based on full_layout
            element_page = page + page_offset if full_layout else page
            for layout in layouts:
                self._draw_layout(
                    layout.get_elements_by_page(element_page, from_pages=True),
                    images[page],
                    page=element_page,
                )

        if out is not None:
            for page in pages:
                output_path = f"{out}_{page+page_offset}.jpg"
                images[page].save(output_path, format="JPEG")
                logger.info(
                    "Layout visualization saved in %s",
                    output_path,
                )
        return images
