"""Utils for layout module"""

import io
import uuid
import base64
from typing import Sequence
from PIL.Image import Image as Im
from ..schemas import (
    AutoPlayoutElement,
    ElementType,
    PLayout,
    Paragraph,
    Extractor,
    Table,
    TableContent,
    Image,
)
from ..utils import is_bbox_within


def filter_overlapping_paragraph(
    elements: list[AutoPlayoutElement], overlapping_threshold: float
) -> list[AutoPlayoutElement]:
    """create dict of overlapping paragraphs
    and remove paragraphs overlapping others (except if all elem are also overlapping others)"""
    overlap_dict: dict[int, list[int]] = {}
    for position1, elem1 in enumerate(elements):
        for position2, elem2 in enumerate(elements):
            if (
                0 < elem1.area < elem2.area
                and isinstance(elem1, Paragraph)
                and isinstance(elem2, Paragraph)
                and is_bbox_within(elem1, elem2, overlapping_threshold)
            ):
                overlap_dict.setdefault(position1, [])
                overlap_dict[position1].append(position2)
    filtered_elements: list[AutoPlayoutElement] = []
    deleted_elements: list[AutoPlayoutElement] = []
    for position, elem in enumerate(elements):
        # remove except if all elem are also in overlap dict
        if position in overlap_dict and not all(
            i in overlap_dict for i in overlap_dict[position]
        ):
            deleted_elements.append(elem)
        else:
            filtered_elements.append(elem)
    return filtered_elements


def filter_overlapping_paragraph_by_page(
    layout: PLayout,
    overlapping_threshold: float,
) -> PLayout:
    """iterate over elements by page and apply filter_overlapping_paragraphs"""
    filtered_elements: list[AutoPlayoutElement] = []
    for elements in layout.iterate_elements_by_page:
        filtered_elements += filter_overlapping_paragraph(
            elements, overlapping_threshold
        )
    filtered_layout = PLayout(filtered_elements)
    filtered_layout.sort_by_bbox()
    return filtered_layout


def filter_tables(
    layout: PLayout,
    overlapping_threshold: float,
    nb_layout: int = 1,
) -> PLayout:
    """Create batch of tables overlapping and keep only one (the one with the most cells)
    if nb_layout > 1, it requires at least 2 tables to be considered as a table"""
    filtered_elements: list[AutoPlayoutElement] = []
    filtered_tables: list[Table | TableContent | Image] = []
    for elements in layout.iterate_elements_by_page:
        tables_list: list[list[Table | TableContent | Image]] = []
        for elem in elements:
            if not isinstance(
                elem,
                (Table, TableContent, Image),
            ):
                filtered_elements.append(elem)
                continue
            add_idx: int | None = None
            for idx, tables in enumerate(tables_list):
                if any(
                    is_bbox_within(elem, table, overlapping_threshold)
                    for table in tables
                ):
                    add_idx = idx
                    break  # what if a table is matching two set of tables ?
                    # => order matters in elements list to define batches of tables.
                    # Tables are sorted by extractor due to the layout order in aggregate_layouts()
                    # so the batch of tables will respect the layout of the first extractors
                    # in default jobs : YOLO > D2 > Tatr
                    # Knowing that if Tatr has predicted cells on YOLO's tables,
                    # YOLO's tables will be positioned first in the Tatr Layout
                    # so the order will remain YOLO > Tatr
            if add_idx is not None:
                tables_list[add_idx].append(elem)
            else:
                tables_list.append([elem])

        for tables in tables_list:
            # if all tables are images, keep them
            if all(table.type == ElementType.IMAGE for table in tables):
                filtered_tables.extend(tables)
                continue
            # if only one layout prediction or
            # ensure atleast two different extractors have predicted the same table
            # or the table is predicted by YOLO
            if (
                nb_layout == 1
                or tables[0].extractor == Extractor.YOLO
                or any(
                    elem.extractor != tables[0].extractor
                    and elem.type != ElementType.IMAGE
                    for elem in tables
                )
            ):
                # remove images that are overlapping with tables
                tables = [table for table in tables if table.type != ElementType.IMAGE]
                # sort by number of cells to append the one with the most cells
                tables.sort(
                    key=lambda x: (len(x.cells or []), x.area),
                    reverse=True,
                )
                filtered_tables.append(tables[0])
    layout.root = filtered_elements + filtered_tables
    layout.sort_by_bbox()
    return layout


def aggregate_layouts(
    *layouts: PLayout,
    overlapping_threshold_paragraph: float = 0.25,
    overlapping_threshold_table: float = 0.5,
) -> PLayout:
    """Function to aggregate layouts by merging them and filtering overlapping paragraphs and tables

    Parameters
    ----------
    layouts: PLayout
        Layouts to aggregate
    overlapping_threshold_paragraph: float
        Threshold to consider a paragraph inside another
    overlapping_threshold_table: float
        Threshold to consider a table inside another

    Returns
    -------
    PLayout
        One Layout with filtered paragraphs and tables
    """
    nb_layout = sum(1 for layout in layouts if layout.root)
    # filter overlapping paragraphs on each layout
    filtered_layouts = [
        filter_overlapping_paragraph_by_page(layout, overlapping_threshold_paragraph)
        for layout in layouts
    ]
    # merge layouts and filter overlapping paragraphs and tables
    merged_layout = PLayout(sum([layout.root for layout in filtered_layouts], []))
    merged_layout = filter_tables(
        merged_layout, overlapping_threshold_table, nb_layout=nb_layout
    )
    merged_layout = filter_overlapping_paragraph_by_page(
        merged_layout, overlapping_threshold_paragraph
    )
    return merged_layout


def pil_image_to_base64(pil_image: Im) -> str:
    """Convert a PIL Image to a base64 encoded string."""
    buffered = io.BytesIO()
    pil_image.save(buffered, format="PNG")
    img_bytes = buffered.getvalue()
    img_base64 = base64.b64encode(img_bytes).decode("utf-8")
    return img_base64


def prepare_image(layout: list[AutoPlayoutElement], pil_images: Sequence[Im]) -> None:
    """Prepare image for LLM prediction:
    set metadata id and crop image"""
    for elem in layout:
        if isinstance(elem, Image):
            elem.metadata["id"] = str(uuid.uuid4())
            width, height = pil_images[elem.page].size
            bbox: tuple[float, float, float, float] = (
                elem.x0 * width,
                elem.y0 * height,
                elem.x1 * width,
                elem.y1 * height,
            )
            cropped_img = pil_images[elem.page].crop(bbox)
            base_64 = pil_image_to_base64(cropped_img)
            elem.metadata["base64"] = base_64
