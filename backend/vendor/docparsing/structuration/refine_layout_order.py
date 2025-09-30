"""Refine layout order based on specific rules"""

import typing as _t
from ..schemas import (
    Paragraph,
    PLayout,
    ElementType,
    AutoPlayoutElement,
)
from ..utils import match_interval


def get_cols_inbetween(
    columns: list[tuple[float, float, float]],
    element1: AutoPlayoutElement,
    element2: AutoPlayoutElement,
) -> list[tuple[float, float, float]]:
    """get columns between two elements"""
    cols: list[tuple[float, float, float]] = []
    for col in columns:
        if (
            (element1.x1 < col[0] < element2.x0 or element2.x1 < col[0] < element1.x0)
            and match_interval((col[1], col[2]), (element1.y0, element1.y1))
            and match_interval((col[1], col[2]), (element2.y0, element2.y1))
        ):
            cols.append(col)
    return cols


def get_elements_by_col(
    col: tuple[float, float, float],
    elements: list[AutoPlayoutElement],
    columns: list[tuple[float, float, float]],
    page: int | None,
) -> list[AutoPlayoutElement]:
    """get elements at the sides of the columns with no columns in between"""
    side_elements: list[AutoPlayoutElement] = []
    for element in elements:
        # check if the element is on the same page and on the side of the column
        if (
            element.page == page
            and (col[0] < element.x0 or col[0] > element.x1)
            and match_interval((element.y0, element.y1), (col[1], col[2]))
        ):
            # check if there is no columns in between
            if not any(
                c != col
                and (col[0] < c[0] < element.x0 or element.x1 < c[0] < col[0])
                and match_interval((element.y0, element.y1), (c[1], c[2]))
                and match_interval((col[1], col[2]), (c[1], c[2]))
                for c in columns
            ):
                side_elements.append(element)
    return side_elements


def titles_sep_by_column(
    layout: PLayout,
    columns: list[list[tuple[float, float, float]]],
    start_pos: int,
) -> int:
    """refine consecutive titles order if they are separated by columns
    and there is only titles or headers in the columns
    return the position of the last element checked"""
    reverse = None
    n = 0
    current_pos = start_pos
    for n, element in enumerate(layout.root[start_pos:]):
        # two consecutive titles on the same page and the second title is above the first(y0)
        current_pos = start_pos + n
        if (
            element.type == ElementType.TITLE
            and current_pos + 1 < len(layout.root)
            and layout.root[current_pos + 1].type == ElementType.TITLE
            and element.page is not None
            and element.page == layout.root[current_pos + 1].page
            and element.y0 > layout.root[current_pos + 1].y0
        ):
            # get columns between the two titles
            cols_inbetween = get_cols_inbetween(
                columns[element.page], element, layout.root[current_pos + 1]
            )
            # get elements at the sides of the columns
            side_elements = []
            for col in cols_inbetween:
                side_elements = get_elements_by_col(
                    col, layout.root, columns[element.page], element.page
                )
            # if there is only titles or headers in the columns, swap the two titles
            if all(
                elem.type
                in [
                    ElementType.TITLE,
                    ElementType.EXTRA,
                    ElementType.HEADER,
                    ElementType.FOOTER,
                ]
                for elem in side_elements
            ):
                reverse = [current_pos, current_pos + 1]
                break

    # swap the two titles in the layout
    if reverse is not None:
        title = layout.root[reverse[1]]
        layout.root.pop(reverse[1])
        layout.root.insert(reverse[0], title)
    return current_pos + 1


def anchor_headers_to_edges(layout: PLayout, edge: _t.Literal["top", "bottom"]) -> None:
    """Move headers to the top or bottom of the layout based on y0 position
    This rule avoid having headers in the middle of two columns content"""
    to_move: list[AutoPlayoutElement] = []
    for elements in layout.iterate_elements_by_page:
        if edge == "top":
            layout_sorted_by_y0 = sorted(elements, key=lambda x: (x.y0, x.x0))
        else:
            layout_sorted_by_y0 = sorted(elements, key=lambda x: (-x.y0, x.x0))
        for element in layout_sorted_by_y0:
            # skip vertical paragraphs
            if isinstance(element, Paragraph) and element.is_vertical:
                continue

            if element.type in [
                ElementType.EXTRA,
                ElementType.HEADER,
                ElementType.FOOTER,
            ]:
                to_move.append(element)
            else:
                break

    # move headers to the top or bottom of the layout
    for element in to_move[::-1]:
        layout.root.remove(element)
        if edge == "top":
            layout.root.insert(0, element)
        else:
            layout.root.append(element)
    # sort the layout by page so that headers are at the top/bottom of their own page
    layout.sort_by_page()


def refine_layout_order(
    layout: PLayout,
    columns: list[list[tuple[float, float, float]]],
) -> None:
    """Refine layout order based on specific rules"""
    # refine consecutive titles order based on y0
    # if they are separated by a column and there is only titles or headers in the columns
    n = 0
    while n < len(layout.root):
        n = titles_sep_by_column(layout, columns, n)

    # anchor headers to the top and bottom of the layout based on y0 position
    anchor_headers_to_edges(layout, "top")
    anchor_headers_to_edges(layout, "bottom")
