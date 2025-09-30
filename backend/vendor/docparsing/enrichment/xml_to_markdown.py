"""Convert XML to Markdown"""

from typing import Literal, Any
import logging
import ast
from json import dumps
from defusedxml import defuse_stdlib
from ..latex_table import flat_table_to_latex

# Make standard XML libraries secure
defuse_stdlib()
# using "nosec" to avoid bandit issue as it is fixed by calling defuse_stdlib() before the import
from xml.etree import ElementTree as ET  # nosec # pylint: disable=C0413, C0411 # noqa: E402

logger = logging.getLogger(__name__)


def _list_to_markdown(elem: ET.Element, list_starters: list[str]) -> str:
    """Convert HTML list to Markdown list"""
    markdown_str = ""
    for item in elem.iter():
        if item.tag in ["li", "dd"]:
            text = [word.text for word in item if word.tag == "word"]
            for starter in list_starters:
                if text[0] is not None and text[0].startswith(starter):
                    text[0] = text[0].replace(starter, "", 1).rstrip()
            markdown_str += (
                "- " + " ".join([t for t in text if t is not None]).strip() + "\n"
            )
        elif item.tag == "dt":
            text = [word.text for word in item if word.tag == "word"]
            markdown_str += " ".join([t for t in text if t is not None]).strip() + "\n"
    return markdown_str


def _html_table_to_markdown(html_table: ET.Element) -> str:
    """Convert HTML table to Markdown table:
    - html_table to flattened table
    - duplicate rowspan and colspan values
    - content to Markdown format
    return Markdown table as string"""
    flat_table = _html_to_flat_table(html_table)
    # duplicate rowspan and colspan values
    for n, row in enumerate(flat_table):
        for m, cell in enumerate(row):
            if cell[0] is None and m > 0 and cell[2] > 1:
                flat_table[n][m] = row[m - 1]
            elif cell[0] == "" and n > 0 and cell[1] > 1:
                flat_table[n][m] = flat_table[n - 1][m]
    # content to Markdown format
    markdown_table = [
        "|" + "|".join([cell[0] if cell[0] is not None else "" for cell in row]) + "|"
        for row in flat_table
    ]
    # Add the Markdown separator after the header
    if len(markdown_table) > 1:
        header_separator = "|" + "---|" * (len(markdown_table[0].split("|")) - 2)
        markdown_table.insert(1, header_separator)
    # Join the rows into a final Markdown string
    markdown_str = "\n".join(markdown_table)
    return markdown_str


def _html_to_flat_table(
    html_table: ET.Element,
) -> list[list[tuple[str | None, int, int]]]:
    """Convert HTML table to a flattened table list[list[cell]]
    with cell: tuple(text, rowspan, colspan)
     for spanning cells:
        (text, rowspan, colspan) for the first cell (top left of the spanning cell)
        ("", rowspan, colspan) means that the cell is part of a rowspan cell and in the first column
        (None, rowspan, colspan) means that the cell is part of a colspan cell"""
    rows = html_table.findall("tr")
    cells_first_row = rows[0].findall("td")
    nb_cols = sum(
        1 if cell.attrib.get("colspan") is None else int(cell.attrib["colspan"])
        for cell in cells_first_row
    )
    tmp_flat_table: list[list[tuple[str | None, int, int] | str]] = [
        [""] * nb_cols for _ in range(len(rows))
    ]
    for i, row in enumerate(rows):
        cells = row.findall("td")
        for cell in cells:
            colspan = int(cell.attrib.get("colspan", 1))
            rowspan = int(cell.attrib.get("rowspan", 1))
            text = cell.text if cell.text is not None else ""
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
                            i,
                        )
                        break  # avoid index error
                    tmp_flat_table[i + j][cell_position] = (
                        "",
                        rowspan,
                        colspan,
                    )
                    for k in range(1, colspan):
                        if cell_position + k >= len(tmp_flat_table[i + j]):
                            logger.warning(
                                "Cell with colspan %d exceeds row length %d at row %d",
                                colspan,
                                len(tmp_flat_table[i + j]),
                                i + j,
                            )
                            break  # avoid index error
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


def _html_table_to_latex(html_table: ET.Element) -> str:
    """Convert HTML table to LaTeX table:
    - html_table to flattened table
    - create a LaTeX table with MultiRow and MultiColumn
    - add hline between rows except when rowspan > 1
    return LaTeX table as string"""
    flat_table = _html_to_flat_table(html_table)
    latex_table = flat_table_to_latex(flat_table)
    return latex_table


def xml_to_markdown(
    root: ET.Element,
    list_starters: list[str],
    table_format: Literal["latex", "markdown"],
) -> str:
    """
    Convert XML to markdown
    """
    markdown: str = ""
    previous_title = 0
    for elem in root.iter():
        if elem.tag == "word":
            continue
        elem_info: dict[str, Any] = {
            "split_candidate": ast.literal_eval(
                elem.attrib.get("split_candidate", "None")
            ),
            "type": elem.tag,
            "pages": ast.literal_eval(elem.attrib.get("pages", "None")),
            "bboxes": ast.literal_eval(elem.attrib.get("bboxes", "None")),
        }
        if elem.tag == "image":
            elem_info["id"] = elem.attrib.get("id", "None")
        if elem_info["split_candidate"] is not None:
            markdown += f"<!-- {dumps(elem_info)} -->\n"
        if elem.tag in ["title", "text", "list", "extra", "header", "footer", "image"]:
            if elem.tag == "list":
                markdown += _list_to_markdown(elem, list_starters) + "\n\n"
                previous_title = 1 if previous_title != 0 else 0
                continue
            if elem.tag == "title":
                markdown += f"{'#' * min(previous_title + 1, 6)} "
                previous_title += 1
            else:
                previous_title = 1 if previous_title != 0 else 0
            text = " ".join(
                [
                    word.text
                    for word in elem
                    if word.tag == "word" and word.text is not None
                ]
            )
            markdown += text + "\n\n"
        elif elem.tag in ["table"]:
            if elem.text is not None and elem.text.strip().startswith(
                "\\documentclass"
            ):
                # LaTeX table
                markdown += elem.text + "\n\n"
            elif table_format == "markdown":
                markdown += _html_table_to_markdown(elem) + "\n\n"
            elif table_format == "latex":
                markdown += _html_table_to_latex(elem) + "\n\n"

    return markdown
