"""Utility functions for enrichement module"""

from typing import Literal, Pattern
from ..schemas import Word, PLayout, Extra, TableContent, Cell, VisualElement


def get_lines(content: list[Word]) -> list[tuple[Word, Word, int]]:
    """
    Delimit lines based on the x0 coordinate of the words
    lines format : list[tuple[first_word, last_word, idx_first_word]]
        first_word: first word of the line
        last_word: last word of the line
        idx_first_word: index of the first word in the line
    """
    start_line = [(content[0], 0)] + [
        (word, i + 1) for i, word in enumerate(content[1:]) if word.x0 < content[i].x0
    ]
    lines: list[tuple[Word, Word, int]] = []
    for n, st in enumerate(start_line):
        if n == len(start_line) - 1:
            lines.append((st[0], content[-1], st[1]))
        else:
            lines.append((st[0], content[start_line[n + 1][1] - 1], st[1]))

    return lines


def count_start_chars(
    lines: list[tuple[Word, Word, int]],
    list_starters: list[str],
    regex_num_starter: Pattern[str],
) -> dict[str, list[int]]:
    """
    Get indexes of specific starting characters and ending characters
    - dash: starts with a dash
    - number: starts with a number
    - upper: starts with an uppercase letter
    - colon: ends with a colon (idx of the first word of the line that ends with ":")
    """
    start_chars: dict[str, list[int]] = {
        "dash": [],
        "number": [],
        "upper": [],
        "colon": [],
    }

    # idx of the first word of the last line that was not a list element
    # so multiple lines can be joined if they are not list elements
    # and le last word ends with ":"
    prev_line_start = None
    for first_word, last_word, idx_start in lines:
        if first_word.content.startswith(tuple(list_starters)):
            start_chars["dash"].append(idx_start)
            prev_line_start = None
        elif regex_num_starter.match(first_word.content):
            start_chars["number"].append(idx_start)
            prev_line_start = None
        elif first_word.content.isupper():
            start_chars["upper"].append(idx_start)
            prev_line_start = None
        else:
            if prev_line_start is None:
                prev_line_start = idx_start
            if last_word.content.endswith(":"):
                start_chars["colon"].append(prev_line_start)

    return start_chars


def get_position_page_element(
    layout: PLayout, page: int, elem: Literal["first", "last"]
) -> int | None:
    """Get the position of the first or last element on a page"""
    if elem == "first":
        for position, element in enumerate(layout.root):
            if element.page == page:
                return position
    elif elem == "last":
        for position, element in enumerate(layout.root[::-1]):
            if element.page == page:
                return len(layout.root) - position
    return None


def get_next_candidate_position(position: int, layout: PLayout) -> int | None:
    """Get the position of next elements of a given element position,
    skipping the Extra elements and inferred elements.
    We allow to skip inferred elements only if an Extra element is also skipped in the process.
    return the index of the next element or None if there is no next element
    """
    skipped_extra = False
    skipped_inferred = False
    for next_elem_offset, element in enumerate(layout.root[position + 1 :]):
        if not isinstance(element, (Extra, VisualElement)) and not element.inferred:
            if skipped_inferred and not skipped_extra:
                break
            return position + next_elem_offset + 1
        if isinstance(element, Extra):
            skipped_extra = True
        if element.inferred:
            skipped_inferred = True
    return None


def is_cutting_a_cell(
    current_cell: Cell,
    cell_list: list[Cell],
    x_offset_current: float,
    x_offset_list: float,
    tolerance_threshold: float,
) -> bool:
    """
    Check if the current cell is cutting a cell in the cell_list
    by checking if the current cell x0 and x1 are between the x0 and x1 of a cell in the cell_list
    with a tolerance of 10% of the cell width
    unless the cell is a spanning cell
    use offset to pad the x values to 0 (left of the page)
    """
    for cell in cell_list:
        if cell.label in ["spanning_cell", "spanning_header"]:
            continue
        x_tolerance = tolerance_threshold * (cell.x1 - cell.x0)
        if (
            cell.x0 + x_tolerance - x_offset_list
            < current_cell.x0 - x_offset_current
            < cell.x1 - x_tolerance - x_offset_list
            or cell.x0 + x_tolerance - x_offset_list
            < current_cell.x1 - x_offset_current
            < cell.x1 - x_tolerance - x_offset_list
        ):
            return True
    return False


def columns_matching(
    table1: TableContent, table2: TableContent, tolerance_threshold: float
) -> bool:
    """
    Check if the two tables columns boundaries are matching
    by checking if the columns on the last row of table1
    and the first row of table2 are coherent together
    """
    if table1.cells is None or table2.cells is None:
        return False
    table1_row = table1.cells[-table1.nb_columns :]
    table2_row = table2.cells[: table2.nb_columns]

    x_offset_table1 = table1_row[0].x0
    x_offset_table2 = table2_row[0].x0

    for table1_cell in table1_row:
        if is_cutting_a_cell(
            table1_cell,
            table2_row,
            x_offset_table1,
            x_offset_table2,
            tolerance_threshold,
        ):
            return False
    for table2_cell in table2_row:
        if is_cutting_a_cell(
            table2_cell,
            table1_row,
            x_offset_table2,
            x_offset_table1,
            tolerance_threshold,
        ):
            return False
    return True
