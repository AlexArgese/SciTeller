"""Utility functions for docparsing module"""

import io
import re
import math
import logging
import unicodedata
from typing import Generator, Any, Sequence, TypeVar
from functools import lru_cache
import numpy as np
from pdf2image import convert_from_bytes
from PIL.Image import Image
import fitz
from .schemas import (
    Bbox,
    WLayout,
    LLayout,
    PLayout,
    AutoPlayoutElement,
    AutoWlayoutElement,
    AutoLlayoutElement,
    Word,
    Line,
    Paragraph,
    TableContent,
)

logger = logging.getLogger(__name__)


def match_interval(
    interval1: tuple[float, float],
    interval2: tuple[float, float],
    threshold: float | None = None,
) -> bool:
    """Check if two intervals overlap
    if threshold is set, check if the overlap is greater than threshold"""
    if threshold is None:
        return interval1[0] < interval2[1] and interval2[0] <= interval1[1]

    start = max(interval1[0], interval2[0])
    end = min(interval1[1], interval2[1])
    return max(0.0, end - start) / (interval1[1] - interval1[0]) >= threshold


def calculate_intersection_area(elem1: Bbox, elem2: Bbox) -> float:
    """Calculate the intersection area between two bounding boxes"""
    if (
        elem1.x0 >= elem2.x1
        or elem2.x0 >= elem1.x1
        or elem1.y0 >= elem2.y1
        or elem2.y0 >= elem1.y1
    ):
        return 0
    x0, y0 = max(elem1.x0, elem2.x0), max(elem1.y0, elem2.y0)
    x1, y1 = min(elem1.x1, elem2.x1), min(elem1.y1, elem2.y1)
    return max(0, (x1 - x0) * (y1 - y0))


def is_bbox_within(elem1: Bbox, elem2: Bbox, overlap_threshold: float = 0.8) -> bool:
    """Check if elem1 have more than 80% (overlap_threshold) of its area in elem2"""
    if overlap_threshold < 0:
        raise ValueError("overlap_threshold must be greater than 0")
    if elem1.area > 0:
        if (
            calculate_intersection_area(elem1, elem2) / elem1.area
        ) >= overlap_threshold:
            return True
    return False


def is_pua(char: str) -> bool:
    """Check if a character is in the Private Use Area (PUA) of Unicode."""
    code = ord(char)
    return (
        0xE000 <= code <= 0xF8FF
        or 0xF0000 <= code <= 0xFFFFD
        or 0x100000 <= code <= 0x10FFFD
    )


def is_unreadable(char: str) -> bool:
    """Check if a character is unreadable or a Private Use Area (PUA) character."""
    try:
        _ = unicodedata.name(char)
        return False
    except ValueError:
        return True  # Characters with no name are likely non-readable
    except Exception as _e:
        return is_pua(char)


def check_unreadable_chars(
    words: list[dict[str, Any]], unreadable_char_threshold: float
) -> bool:
    """Check if there are too many unreadable characters in the words"""
    step = unreadable_char_threshold * len(words)
    unreadable_count = 0
    for word in words:
        if any(is_unreadable(char) for char in word["text"]):
            unreadable_count += 1
            if unreadable_count > step:
                return True
    return False


def check_cid_error(words: list[dict[str, Any]], cid_error_threshold: float) -> bool:
    """Check if there are too many CID errors in the words"""
    step = cid_error_threshold * len(words)
    cids = 0
    for word in words:
        if re.findall(r"(\(cid\:\d+\))", word["text"]):
            cids += 1
            if cids > step:
                return True
    return False


@lru_cache(maxsize=1)
def pdf_to_pil_images(
    pdf_bytesio: io.BytesIO, dpi: int = 300, grayscale: bool = False
) -> Sequence[Image]:
    """Convert BytesIO to PIL"""
    if pdf_bytesio.getbuffer().nbytes == 0:
        return []
    return convert_from_bytes(pdf_bytesio.getvalue(), dpi, grayscale=grayscale)


def pdf_to_np_images(
    pdf_bytesio: io.BytesIO, dpi: int = 300, grayscale: bool = False
) -> Sequence[np.ndarray[Any, np.dtype[np.uint8]]]:
    """Convert BytesIO to PIL to Numpy"""
    pil_images = pdf_to_pil_images(pdf_bytesio, dpi, grayscale)
    return [np.array(image) for image in pil_images]


def batchify_pdf(
    pdf_bytesio: io.BytesIO, nb_pages: int | None
) -> Generator[io.BytesIO, None, None]:
    """Yield batch of pages"""
    pdf_bytesio.seek(0)
    pdf_document = fitz.open("pdf", pdf_bytesio.read())
    total_pages = pdf_document.page_count
    if nb_pages is None:
        nb_pages = total_pages
    for start in range(0, total_pages, nb_pages):
        end = min(start + nb_pages, total_pages)
        new_pdf_document = fitz.open()
        new_pdf_document.insert_pdf(
            pdf_document, from_page=start, to_page=end - 1, widgets=False
        )
        output = io.BytesIO()
        new_pdf_document.save(output)
        output.seek(0)
        yield output


# TODO: Refacto to use insert_pdf from_page and to_page arguments
#       instead of iterating over all pages


def load_pdf_batch(
    pdf_path: str, batch_size: int = 0
) -> Generator[io.BytesIO, None, None]:
    """
    Yields batches of PDF pages as io.BytesIO objects.

    Args:
        pdf_path (str): Path to the PDF file.
        batch_size (int): Number of pages per batch. 0 to yield the entire PDF at once.

    Yields:
        io.BytesIO: A BytesIO object containing the batch of pages as a new PDF.
    """
    pdf_document = fitz.open(pdf_path)
    total_pages = pdf_document.page_count
    if batch_size <= 0:
        batch_size = total_pages  # Yield the entire PDF if batch_size is not set
    total_batches = math.ceil(total_pages / batch_size)
    logger.info(
        "\033[97mTotal pages: %s, Batch size: %s, Total batches: %s\033[0m",
        total_pages,
        batch_size,
        total_batches,
    )
    for start_page in range(0, total_pages, batch_size):
        # Create a new PDF writer for the batch
        writer = fitz.Document()
        end_page = min(start_page + batch_size, total_pages)
        # Add pages in the current batch to the writer
        writer.insert_pdf(
            pdf_document, from_page=start_page, to_page=end_page - 1, widgets=False
        )
        # Save the batch to a BytesIO object
        buffer = io.BytesIO()
        writer.save(buffer)
        writer.close()
        # Reset the buffer position to the start and yield it
        buffer.seek(0)
        yield buffer


def select_pages_pdf(pdf_bytesio: io.BytesIO, pages: list[int]) -> io.BytesIO:
    """Select pages from a pdf

    Parameters
    ----------
    pdf_bytesio: io.BytesIO
        PDF file in BytesIO format
    pages: list[int]
        List of page numbers to select

    Returns
    -------
    io.BytesIO
        PDF file in BytesIO format with selected pages
    """
    pdf_bytesio.seek(0)
    pdf_document = fitz.open("pdf", pdf_bytesio.read())
    total_pages = pdf_document.page_count
    if all(page >= total_pages for page in pages):
        return io.BytesIO()

    new_pdf_document = fitz.open()
    for start in range(0, total_pages):
        if start in pages:
            new_pdf_document.insert_pdf(
                pdf_document, from_page=start, to_page=start, widgets=False
            )
    output = io.BytesIO()
    new_pdf_document.save(output)
    output.seek(0)
    return output


# Create a type variable constrained to those types
T = TypeVar("T", WLayout, LLayout, PLayout)


def merge_layouts(
    *layout_and_pages: tuple[T, list[int]],
) -> T:
    """Merge layout by page

    Parameters
    ----------
    layout_and_pages: tuple[WLayout | LLayout | PLayout, list[int]]
        Extracted Layout and corresponding pages

    Returns
    -------
    WLayout | LLayout | PLayout
        Merged layout
    """
    merged_layout: (
        list[AutoWlayoutElement] | list[AutoLlayoutElement] | list[AutoPlayoutElement]
    ) = []
    for layout, pages in layout_and_pages:
        pages = sorted(pages)
        corresp = {i: pages[i] for i in range(len(pages))}
        already_processed: list[Word] = []  # not to process the same word twice
        for elem in layout.root:
            elem.metadata["page"] = corresp[elem.page]
            if isinstance(elem, (Line, Paragraph)):
                for word in elem.content:
                    if word in already_processed:
                        logger.warning(
                            "In merge_layouts(), a word object appears twice in the layout: %s",
                            word.content,
                        )
                        continue
                    word.metadata["page"] = corresp[word.page]
                    already_processed.append(word)
            elif isinstance(elem, TableContent):
                if elem.cells:
                    modified = []  # modifying spanning cells only once
                    for cell in elem.cells:
                        if cell not in modified:
                            cell.metadata["page"] = corresp[cell.page]
                            modified.append(cell)
            merged_layout.append(elem)
    if any(isinstance(elem, Word) for elem in layout_and_pages[0][0].root):
        layout = WLayout(merged_layout)
    elif any(isinstance(elem, Line) for elem in layout_and_pages[0][0].root):
        layout = LLayout(merged_layout)
    else:
        layout = PLayout(merged_layout)
    layout.sort_by_page()
    return layout
