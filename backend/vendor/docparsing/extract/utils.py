"""Utils for extracting content from OCR"""

import io
from typing import Generator
import fitz  # PyMuPDF

from .process_table import build_cells, make_table_content
from ..schemas import (
    Table,
    PLayout,
    LLayout,
    WLayout,
    Word,
    Line,
    ElementType,
    VisualElement,
)
from ..utils import is_bbox_within


def get_pdf_page_info(
    file_content: io.BytesIO, page_number: int = 0
) -> tuple[int, int, int]:
    """Get the number of pages, width, and height of a PDF."""
    pdf_document = fitz.open(stream=file_content, filetype="pdf")
    num_pages = pdf_document.page_count
    page = pdf_document[page_number]
    width, height = page.rect.width, page.rect.height
    pdf_document.close()
    return num_pages, width, height


def get_word_list(
    ocr: WLayout | LLayout | list[Line],
) -> Generator[list[Word], None, None]:
    """Get list of words from ocr
    yield it by line"""
    if not ocr:
        yield []
    else:
        if any(isinstance(elem, Word) for elem in ocr):
            # filter Visual Elements
            yield [elem for elem in ocr if isinstance(elem, Word)]
        else:
            for line in ocr:
                if isinstance(line, Line):  # filter Visual Elements
                    yield line.content


def enumerate_word_list(
    ocr: WLayout | LLayout | list[Line],
) -> Generator[tuple[int, list[Word]], None, None]:
    """Get list of words from ocr
    yield it by line"""
    if not ocr:
        yield 0, []
    else:
        if any(isinstance(elem, Word) for elem in ocr):
            # filter Visual Elements
            yield 0, [elem for elem in ocr if isinstance(elem, Word)]
        else:
            for i, line in enumerate(ocr):
                if isinstance(line, Line):  # filter Visual Elements
                    yield i, line.content


def populate_table(
    layout: PLayout,
    element: Table,
    ocr: WLayout | LLayout,
    threshold_word: float,
) -> list[tuple[int, int]]:
    """Populate table with ocr content:
        - listing words inside table
        - build cells list from words inside table if not already done
        - create TableContent and populate it with words according to cells
        - replace element Table with new element TableContent in layout
    return list of coordinates (n_line, n_word) to pop from ocr"""
    table_content: list[Word] = []
    to_pop: list[tuple[int, int]] = []
    for n_line, line in enumerate_word_list(ocr):
        for n_word, word in enumerate(line):
            if not isinstance(word, Word):
                continue
            if is_bbox_within(word, element, threshold_word):
                table_content.append(word)
                to_pop.append((n_line, n_word))
    if not element.cells:
        build_cells(element, table_content)
    new_element = make_table_content(element, table_content, threshold_word)
    if new_element is not None:
        layout.replace_element(element, new_element)
    return to_pop


def pop_words_from_ocr(
    ocr: list[Word | VisualElement] | list[Line | VisualElement],
    to_pop: list[tuple[int, int]],
) -> None:
    """Pop words from ocr using coordinates (n_line, n_word)"""
    for pop_coord in to_pop[::-1]:
        if not ocr:
            raise ValueError(
                "couldn't pop word from ocr, ocr is empty, coordinates:", pop_coord
            )
        if any(isinstance(elem, Line) for elem in ocr):
            ocr[pop_coord[0]].content.pop(pop_coord[1])
        elif any(isinstance(elem, Word) for elem in ocr):
            ocr.pop(pop_coord[1])


def populate_tables(
    layout_ocr: WLayout | LLayout,
    layout: PLayout,
    pop_words: bool = True,
    threshold_word: float = 0.8,
) -> PLayout:
    """Function to populate tables from a Layout with an OCR Layout

    Parameters
    ----------
    layout_ocr: WLayout | LLayout
        OCR Layout of words
    layout: PLayout
        Layout containing tables to populate
    pop_words: bool
        Boolean to pop words from ocr
    threshold_word: float
        Threshold to consider a word inside a table

    Returns
    -------
    PLayout
        Layout with tables populated with ocr content

    """
    # copy ocr to avoid modifying original when pop_words is False and ocr is Layout[Line]
    if pop_words is False:
        layout_ocr = layout_ocr.model_copy(deep=True)
    to_pop_list: list[list[tuple[int, int]]] = []
    page_count = max(layout.page_count, layout_ocr.page_count)
    # Iterate by page and Populate tables with ocr content
    for page in range(page_count):
        layout_page = layout.get_elements_by_page(page)
        ocr_page = layout_ocr.get_elements_by_page(page)
        for element in layout_page:
            if element.type == ElementType.TABLE:
                to_pop = populate_table(layout, element, ocr_page, threshold_word)
                pop_words_from_ocr(ocr_page, to_pop)
                to_pop_list.append(to_pop)
    # pop words from ocr when pop_words is True and ocr is WLayout
    if (
        pop_words is True
        and layout_ocr.root
        and any(isinstance(elem, Word) for elem in layout_ocr.root)
    ):
        for to_pop in to_pop_list:
            for coord in to_pop[::-1]:
                layout_ocr.root.pop(coord[1])
    return layout
