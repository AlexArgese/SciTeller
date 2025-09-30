"""Sort layout by reading order"""

import logging
from ..schemas import (
    PLayout,
    AutoPlayoutElement,
    AutoLayoutElement,
    Title,
    WLayout,
    LLayout,
    Word,
    Extra,
)
from ..utils import match_interval

logger = logging.getLogger(__name__)


def block_contain_space(
    s: tuple[float, float],
    element: AutoLayoutElement,
    y_min: float,
    x_tolerance_ratio: float = 0.04,
) -> bool:
    """Check if the space interval is contained in the element or almost contained"""
    # x_tolerance based on the smallest interval between element and space interval
    # no tolerance for top page columns
    x_tolerance = (
        min(s[1] - s[0], element.extended_x1 - element.extended_x0) * x_tolerance_ratio
        if y_min > 0
        else 0
    )
    if (
        element.extended_x0 - x_tolerance <= s[0] <= element.extended_x1
        and element.extended_x0 <= s[1] <= element.extended_x1 + x_tolerance
    ):
        return True
    return False


def is_significant_gap(
    space_interval: tuple[float, float],
    element: AutoLayoutElement,
    min_gap_ratio: float = 1.0,
) -> bool:
    """check if the leftover gap is smaller than 1.0 of the Word height,
    this is used to determine if the gap interval is too small to be considered"""
    if isinstance(element, Word):
        return (
            space_interval[1] - space_interval[0]
            > (element.y1 - element.y0) * min_gap_ratio
        )
    return True


def split_interval(
    space: list[tuple[float, float]],
    element: AutoLayoutElement,
    y_min: float,
) -> tuple[list[tuple[float, float]], list[tuple[float, float, float]]]:
    """Split each space interval depending of the element
    append to space_columns if the space interval is contained in the element
    and set y_max as element.y0"""
    new_space: list[tuple[float, float]] = []
    columns: list[tuple[float, float, float]] = []
    for s in space:
        # block contain space or almost contain space
        if block_contain_space(s, element, y_min):
            columns.append((s[0] + (s[1] - s[0]) / 2, y_min, element.y0))
        # block is include in space
        elif (
            s[0] <= element.extended_x0 <= s[1] and s[0] <= element.extended_x1 <= s[1]
        ):
            if is_significant_gap((s[0], element.extended_x0), element):
                new_space.append((s[0], element.extended_x0))
            else:
                columns.append((s[0] + (s[1] - s[0]) / 2, y_min, element.y0))
            if is_significant_gap((element.extended_x1, s[1]), element):
                new_space.append((element.extended_x1, s[1]))
            else:
                columns.append((s[0] + (s[1] - s[0]) / 2, y_min, element.y0))
        # block overlap
        elif s[0] <= element.extended_x0 <= s[1]:
            if is_significant_gap((s[0], element.extended_x0), element):
                new_space.append((s[0], element.extended_x0))
            else:
                columns.append((s[0] + (s[1] - s[0]) / 2, y_min, element.y0))
        elif s[0] <= element.extended_x1 <= s[1]:
            if is_significant_gap((element.extended_x1, s[1]), element):
                new_space.append((element.extended_x1, s[1]))
            else:
                columns.append((s[0] + (s[1] - s[0]) / 2, y_min, element.y0))
        # block doesn't overlap
        else:
            new_space.append(s)
    return new_space, columns


def extend_title_bbox(
    elements: list[AutoPlayoutElement], y_tolerance_ratio: float = 0.1
) -> None:
    """Extend the title element bbox on X based on the elements below it
    this is used to stop the space columns on the title rather than the elements below it.
    The algorithm works as follows:
    - iterate over each Title elements
    - find elements below, meaning: matching on X interval with the min y0
    (list of candidates if several elements match on X and have similar y0),
    - set "extended_x" metadata with the min x0 and max x1 of the candidates.
    - if the title overlaps with any other element, skip the "extended_x" metadata
    The y_tolerance_ratio is used to set a y_tolerance on the y0 of the candidates
    to determine if candidates have similar y0.
    """
    for current_element in elements:
        if not isinstance(current_element, Title):
            continue
        next_element_candidates: list[AutoPlayoutElement] = []
        # set y_tolerance based on the title element bbox
        y_tolerance = (current_element.y1 - current_element.y0) * y_tolerance_ratio
        for next_element in elements:
            # is below and matching on X interval
            if next_element.y0 > current_element.y1 and match_interval(
                (next_element.x0, next_element.x1),
                (current_element.x0, current_element.x1),
            ):
                # candidates list is empty => add next_element
                if not next_element_candidates:
                    next_element_candidates.append(next_element)
                # next_element has same y0 as all current candidates => append to candidates
                elif all(
                    candidate.y0 - y_tolerance
                    < next_element.y0
                    < candidate.y0 + y_tolerance
                    for candidate in next_element_candidates
                ):
                    next_element_candidates.append(next_element)
                # next_element is above all current candidates => replace all candidates
                elif all(
                    next_element.y0 < candidate.y0
                    for candidate in next_element_candidates
                ):
                    next_element_candidates = [next_element]
        # set extended_x in metadata based on candidates
        if next_element_candidates:
            extended_x = (
                min(current_element.x0, *[e.x0 for e in next_element_candidates]),
                max(current_element.x1, *[e.x1 for e in next_element_candidates]),
            )
            # set extended_x if Title doesn't overlap with any other element
            if not any(
                match_interval(
                    extended_x,
                    (element.x0, element.x1),
                )
                and match_interval(
                    (current_element.y0, current_element.y1),
                    (element.y0, element.y1),
                )
                for element in elements
                if element is not current_element
            ):
                current_element.metadata["extended_x"] = extended_x


def detect_columns(
    layout: PLayout, layout_ocr: WLayout | LLayout | None = None
) -> list[list[tuple[float, float, float]]]:
    """Detect vertical lines of space starting from top of the page and from y1 of each element
    if provided, also use layout_ocr to calculate space gap below each elements of the layout.
    extend Title Element X interval based on elements below it (by setting "extended_x" in metadata)
    add columns starting from element to element.metadata["columns"]
    return list of columns format : list[tuple[x, y0, y1]]"""
    columns_by_page: list[list[tuple[float, float, float]]] = []
    for elements in layout.iterate_elements_by_page:
        # extend Title Element X interval based on elements below it,
        # by setting "extended_x" in metadata
        extend_title_bbox(elements)
        if not elements:
            columns_by_page.append([])
            continue
        space_columns: list[tuple[float, float, float]] = []
        # from top of the page
        x_interval = [(0.0, 1.0)]
        for element in elements:
            if isinstance(element, Extra):
                continue
            if element.y0 > 0:
                x_interval, columns = split_interval(
                    x_interval,
                    element,
                    0,
                )
                space_columns += columns
        space_columns += [(s[0] + ((s[1] - s[0]) / 2), 0, 1) for s in x_interval]
        # from each element
        all_elem = elements
        if layout_ocr is not None and elements:
            all_elem = elements + layout_ocr.get_elements_by_page(elements[0].page)
            all_elem = sorted(all_elem, key=lambda x: (x.y0, x.x0))
        for start_element in elements:
            start_element.metadata.setdefault("columns", [])
            x_interval = [(start_element.x0, start_element.x1)]
            for element in all_elem:
                if element.y0 > start_element.y1:
                    x_interval, columns = split_interval(
                        x_interval,
                        element,
                        start_element.y1,
                    )
                    start_element.metadata["columns"] += columns
            start_element.metadata["columns"] += [
                (s[0] + ((s[1] - s[0]) / 2), start_element.y1, 1) for s in x_interval
            ]
            # sort columns starting from the same element by x (mandatory for algo in next step)
            start_element.metadata["columns"] = sorted(
                start_element.metadata["columns"], key=lambda x: x[0]
            )
            # add element's columns to all columns list
            space_columns += start_element.metadata["columns"]
        columns_by_page.append(sorted(space_columns, key=lambda x: (x[1], x[0])))
    return columns_by_page


def filter_relevant_columns(
    all_columns: list[tuple[float, float, float]],
    elements: list[AutoPlayoutElement],
) -> list[tuple[float, float, float]]:
    """Filter columns that are relevant with the elements
    meaning that the column match with at least one element to the left
    of the column but not with all elements"""
    columns: list[tuple[float, float, float]] = []
    for col in all_columns:
        matching_elements = [
            e
            for e in elements
            if e.x0 < col[0] and match_interval((e.y0, e.y1), (col[1], col[2]), 0.1)
        ]
        if len(matching_elements) > 0 and len(matching_elements) != len(elements):
            columns.append(col)
    return columns


def recurs_append_columns(
    elements: list[AutoPlayoutElement],
    column: tuple[float, float, float],
    ordered_layout: list[AutoPlayoutElement],
) -> None:
    """Recursively append elements to ordered_layout:
    - get elements to the left of the current column (from the current element list),
    - iterate over those elements,
    - for each element:
        - append the element,
        - call the recursive function for each column starting from this element"""
    elem_matching_col = [
        elem
        for elem in elements
        if elem.x0 < column[0]
        and match_interval((elem.y0, elem.y1), (column[1], column[2]), threshold=0.1)
    ]
    for element in elem_matching_col:
        if element not in ordered_layout:
            ordered_layout.append(element)
            # all columns from previous elements of the same page
            # in reverse order to prioritize columns from previous elements
            all_prev_col: list[tuple[float, float, float]] = sum(
                [
                    e.metadata.get("columns", [])
                    for e in ordered_layout[::-1]
                    if e.page == element.page
                ],
                [],
            )
            # append previous relevant columns to the current next column to check
            # to avoid columns matching with all elements resulting in
            # prioritize ordering based on columns rather than based on elements sorted by y0
            columns = filter_relevant_columns(all_prev_col, elem_matching_col)
            if columns:
                for col in columns:
                    recurs_append_columns(elem_matching_col, col, ordered_layout)


def sort_layout_by_reading_order(
    layout: PLayout,
    columns: list[list[tuple[float, float, float]]],
) -> PLayout:
    """sort layout by reading order:
    iterate over columns to recursively append elements to ordered_layout
    add rest and print Warning
    return layout"""
    ordered_layout: list[AutoPlayoutElement] = []
    layout.sort_by_bbox()
    for page, elements in enumerate(layout.iterate_elements_by_page):
        for col in columns[page]:
            recurs_append_columns(elements, col, ordered_layout)
        # add columns starting from top of page to metadata of one page element (for visualization)
        # after the recursive process so it doesn't interfere with the sorting of the page
        for col in columns[page]:
            if col[1] == 0 and elements:
                elements[0].metadata.setdefault("columns", []).append(col)
    # add rest of elements (this should not happen so print a warning to investigate)
    for element in layout.root:
        if element not in ordered_layout:
            ordered_layout.append(element)
            logger.warning(
                "Element not matching a column in sort_layout_by_reading_order(): page: %s, type: %s",
                element.page,
                element.type.value,
            )
    layout.root = ordered_layout
    return layout
