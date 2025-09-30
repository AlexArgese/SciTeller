"""Process table"""

import logging
from ..schemas import Table, Word, Cell, TableContent
from ..utils import is_bbox_within

logger = logging.getLogger(__name__)


def split_interval(
    interval_list: list[tuple[float, float]], x0: float, x1: float
) -> list[tuple[float, float]]:
    """Split interval list around a word depending on overlap"""
    new_interval_list: list[tuple[float, float]] = []
    for interval in interval_list:
        if x0 <= interval[0] <= x1 and x0 <= interval[1] <= x1:
            # interval is include in word => ignore
            continue
        if interval[0] <= x0 <= interval[1] and interval[0] <= x1 <= interval[1]:
            # word is include in interval => split interval around word
            new_interval_list.extend([(interval[0], x0), (x1, interval[1])])
        elif interval[0] <= x0 <= interval[1]:
            # word overlap the interval at the end
            new_interval_list.append((interval[0], x0))
        elif interval[0] <= x1 <= interval[1]:
            # word overlap the interval at the start
            new_interval_list.append((x1, interval[1]))
        else:
            # no overlap between word and interval
            new_interval_list.append(interval)
    return new_interval_list


def detect_space(element: Table, words: list[Word]) -> tuple[list[float], list[float]]:
    """Detect lines of space in a table considering words' bbox
    return list of middle of each space interval for x and y"""
    x_interval = [
        (
            min([word.x0 for word in words] + [element.x0]),
            max([word.x1 for word in words] + [element.x1]),
        )
    ]
    y_interval = [
        (
            min([word.y0 for word in words] + [element.y0]),
            max([word.y1 for word in words] + [element.y1]),
        )
    ]
    for word in words:
        x_interval = split_interval(x_interval, round(word.x0, 3), round(word.x1, 3))
        y_interval = split_interval(y_interval, round(word.y0, 3), round(word.y1, 3))

    # get middle of each space interval
    return [
        interval[0] + ((interval[1] - interval[0]) / 2) for interval in x_interval
    ], [interval[0] + ((interval[1] - interval[0]) / 2) for interval in y_interval]


def build_cells(element: Table, table_content: list[Word]) -> None:
    """Build cells' bbox from table content"""
    col_spaces, row_spaces = detect_space(element, table_content)
    if col_spaces and col_spaces[0] > element.x0:
        col_spaces = [element.x0] + col_spaces
    if col_spaces and col_spaces[-1] < element.x1:
        col_spaces = col_spaces + [element.x1]
    if row_spaces and row_spaces[0] > element.y0:
        row_spaces = [element.y0] + row_spaces
    if row_spaces and row_spaces[-1] < element.y1:
        row_spaces = row_spaces + [element.y1]
    element.cells = []
    # build cells from spaces intervals
    for row in range(len(row_spaces) - 1):
        for col in range(len(col_spaces) - 1):
            cell = Cell.create(
                x0=col_spaces[col],
                x1=col_spaces[col + 1],
                y0=row_spaces[row],
                y1=row_spaces[row + 1],
                page=element.page,
            )
            if cell is not None:
                element.cells.append(cell)


def make_table_content(
    element: Table, table_content: list[Word], threshold_word: float
) -> TableContent | None:
    """Populate table content:
    create TableContent and populate it with words according to cells
    make new line when cell x1 is less than previous cell x1
    unless it's the same cell (to manage spanning cells)
    return the new element TableContent"""
    # convert Table to TableContent
    new_element = TableContent.create(
        x0=element.x0,
        x1=element.x1,
        y0=element.y0,
        y1=element.y1,
        cells=element.cells,
        metadata=element.metadata,
        content=[],
    )
    if new_element is None or element.cells is None:
        return None
    line: list[str] = []
    for n_cell, cell in enumerate(element.cells):
        # new line when cell x1 is strict less than previous cell x1
        # unless it's the same cell (to manage spanning cells)
        if n_cell > 0 and (
            cell != element.cells[n_cell - 1]
            and cell.x1 <= element.cells[n_cell - 1].x1
        ):
            new_element.content.append(line)
            line = []
        line.append(
            " ".join(
                word.content.strip(" ")
                for word in table_content
                if is_bbox_within(word, cell, threshold_word)
            )
        )
    if line and any(cell for cell in line):
        new_element.content.append(line)
    return new_element
