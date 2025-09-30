"""This module contains functions to convert a table to LaTeX format."""

import logging
from pylatex import Document, Tabular, MultiRow, MultiColumn, Package

logger = logging.getLogger(__name__)


def make_flat_table(
    list_spanning_cells: dict[int, tuple[int, int]],
    skip_idx: list[int],
    content: list[list[str]],
) -> list[list[tuple[str | None, int, int]]]:
    """Use spanning_cells to get a flattened table list[list[cell]]
    with cell: tuple(text, rowspan, colspan)
    for spanning cells:
        (text, rowspan, colspan) for the first cell (top left of the spanning cell)
        ("", rowspan, colspan) means that the cell is part of a rowspan cell and in the first column
        (None, rowspan, colspan) means that the cell is part of a colspan cell"""
    tmp_flat_table: list[list[tuple[str | None, int, int] | str]] = [
        [""] * len(content[0]) for _ in range(len(content))
    ]
    current_idx = -1  # to start from 0 at first iteration
    for i, row in enumerate(content):
        for cell in row:
            current_idx += 1
            # skip cells that are spanning cells and already processed
            if current_idx in skip_idx:
                continue
            # set rowspan and colspan if cell is a spanning cell
            if current_idx in list_spanning_cells:
                rowspan, colspan = list_spanning_cells[current_idx]
            else:
                rowspan = 1
                colspan = 1
            text = cell
            # skip cells already set
            cell_position = next(
                (
                    i
                    for i, x in enumerate(tmp_flat_table[i])
                    if not isinstance(x, tuple)
                ),
                None,
            )
            if cell_position is None:
                continue
            tmp_flat_table[i][cell_position] = (text, rowspan, colspan)
            if colspan > 1:
                for k in range(1, colspan):
                    if cell_position + k >= len(tmp_flat_table[i]):
                        logger.warning(
                            "Cell with colspan %d exceeds row length %d at row %d",
                            colspan,
                            len(tmp_flat_table[i]),
                            i,
                        )
                        break  # avoid index error
                    tmp_flat_table[i][cell_position + k] = (None, rowspan, colspan)
            if rowspan > 1:
                for j in range(1, rowspan):
                    if i + j >= len(tmp_flat_table):
                        logger.warning(
                            "Cell with rowspan %d exceeds table height %d at row %d",
                            rowspan,
                            len(tmp_flat_table),
                            i + j,
                        )
                        break  # avoid index error
                    tmp_flat_table[i + j][cell_position] = ("", rowspan, colspan)
                    for k in range(1, colspan):
                        if cell_position + k >= len(tmp_flat_table[i + j]):
                            logger.warning(
                                "Cell with colspan %d exceeds row length %d at row %d",
                                colspan,
                                len(tmp_flat_table[i + j]),
                                i + j,
                            )
                            break
                        tmp_flat_table[i + j][cell_position + k] = (
                            None,
                            rowspan,
                            colspan,
                        )
    flat_table: list[list[tuple[str | None, int, int]]] = [
        [("", 1, 1) if isinstance(cell, str) else cell for cell in row]
        for row in tmp_flat_table
    ]
    return flat_table


def add_hlines(
    latex_table: Tabular, hline_skip: list[tuple[int, int]], len_row: int
) -> None:
    """Add hline to the LaTeX table, based on the hline_skip list.
    hline_skip is a list of tuples (n_row, colspan) where n_row is the row number
    and colspan is the number of columns to skip for the hline."""
    start = 0
    for i, colspan in hline_skip:
        if i - start > 1:
            latex_table.add_hline(start=start, end=i)
        start = i + colspan
    if len_row - start > 1:
        latex_table.add_hline(start=start + 1, end=len_row)


def flat_table_to_latex(flat_table: list[list[tuple[str | None, int, int]]]) -> str:
    """Convert a flat table to LaTeX table:
    - create a LaTeX table with MultiRow and MultiColumn
    - add hline between rows except when rowspan > 1
    return LaTeX table as string"""
    nb_cols = len(flat_table[0])
    doc = Document(documentclass="standalone")
    doc.packages.append(Package("multirow"))
    with doc.create(Tabular("|" + "c|" * nb_cols)) as latex_table:
        latex_table.add_hline()
        for n_row, row in enumerate(flat_table):
            latex_row = []
            hline_skip: list[tuple[int, int]] = []
            for n, cell in enumerate(row):
                text = cell[0]
                rowspan = cell[1]
                colspan = cell[2]
                # skip adding hline inside rowspan cells when the next cell is not empty
                # (next cell not empty means it is not part of the rowspan cell so we can add hline)
                if (
                    # is a spanning cell
                    rowspan > 1
                    # is None mean already added by previous cell (part of the rowspan)
                    and cell[0] is not None
                    # is not the last row to check n_row + 1
                    and len(flat_table) > n_row + 1
                    # cell in next row is empty (means we are still inside the rowspan)
                    and not flat_table[n_row + 1][n][0]
                ):
                    # if cell[0] is None:
                    #     hline_skip.append((n, 1))
                    # else:
                    hline_skip.append((n, colspan))
                if text is None:  # means cell is part of the previous rowspan cell
                    continue
                if rowspan > 1 and colspan > 1:
                    latex_row.append(
                        MultiColumn(2, align="|c|", data=MultiRow(2, data=text))
                    )
                elif colspan > 1:
                    latex_row.append(MultiColumn(colspan, align="|c|", data=text))
                elif rowspan > 1:
                    latex_row.append(MultiRow(rowspan, data=text))
                else:
                    latex_row.append(text)
            latex_table.add_row(latex_row)
            add_hlines(latex_table, hline_skip, len(row))
    return doc.dumps()
