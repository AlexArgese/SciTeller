"""Module to build lines from words"""

from ..schemas import Word, Line, LLayout, WLayout, VisualElement
from .utils import no_columns_between_elements


def match_avg_interval(
    line: list[Word], elem: Word, threshold: float, vertical: bool = False
) -> bool:
    """check if match interval y between elem1 and elem2 is higher than threshold"""
    if vertical:
        avg_x0 = sum(word.x0 for word in line) / len(line)
        avg_x1 = sum(word.x1 for word in line) / len(line)
        if elem.x0 <= avg_x1 and avg_x0 <= elem.x1:
            # calcul overlap
            overlap = min(avg_x1, elem.x1) - max(avg_x0, elem.x0)
            # calcul ratio overlap / elem1 width
            ratio = overlap / (elem.x1 - elem.x0)
            return ratio > threshold
    else:
        avg_y0 = sum(word.y0 for word in line) / len(line)
        avg_y1 = sum(word.y1 for word in line) / len(line)
        if elem.y0 <= avg_y1 and avg_y0 <= elem.y1:
            # calcul overlap
            overlap = min(avg_y1, elem.y1) - max(avg_y0, elem.y0)
            # calcul ratio overlap / elem1 width
            ratio = overlap / (elem.y1 - elem.y0)
            return ratio > threshold
    return False


def no_columns_between_elem_and_line(
    line: list[Word], elem: Word, columns: list[list[tuple[float, float, float]]]
) -> bool:
    """Check if there are no columns between elem and line"""
    return all(
        no_columns_between_elements(
            min(elem, word, key=lambda e: e.x0),
            max(elem, word, key=lambda e: e.x0),
            columns[elem.page]
            if elem.page is not None and len(columns) > elem.page
            else [],
            # TODO: fix out of bounds with fives doc n°101, remove "if len(col) > elem.page"
        )
        for word in line
    )


def word_is_in_a_line(
    word: Word,
    batch: list[list[Word]],
    threshold: float,
    columns: list[list[tuple[float, float, float]]] | None,
    vertical: bool = False,
) -> bool:
    """Check if word is in a line from batch
    Append word to line if it matches the interval"""
    for line in batch:
        if match_avg_interval(line, word, threshold, vertical=vertical) and (
            not columns or no_columns_between_elem_and_line(line, word, columns)
        ):
            line.append(word)
            return True
    return False


def build_lines_from_bbox(
    layout_ocr: WLayout,
    threshold: float,
    columns: list[list[tuple[float, float, float]]] | None,
) -> LLayout:
    """Build lines from words matching y0, y1 intervals"""
    # make batch lists of words matching interval y0, y1 on same page
    all_batchs: list[list[Word]] = []
    visual_elements: list[VisualElement] = []
    for words in layout_ocr.iterate_elements_by_page:
        batch: list[list[Word]] = []
        vertical_batch: list[list[Word]] = []
        for word in words:
            if isinstance(word, VisualElement):
                visual_elements.append(word)
                continue
            # split words into vertical and horizontal batches
            if word.metadata.get("vertical", None):
                if not word_is_in_a_line(
                    word, vertical_batch, threshold, columns, vertical=True
                ):
                    vertical_batch.append([word])
            else:
                if not word_is_in_a_line(word, batch, threshold, columns):
                    batch.append([word])
        all_batchs += batch + vertical_batch
    # build lines from all_batchs
    layout_lines: list[Line] = []
    for line in all_batchs:
        line_element = Line.create(
            x0=min(word.x0 for word in line),
            x1=max(word.x1 for word in line),
            y0=min(word.y0 for word in line),
            y1=max(word.y1 for word in line),
            content=sorted(line, key=lambda word: word.x0),
            page=line[0].page,
            extractor=line[0].extractor,
        )
        if line_element is not None:
            layout_lines.append(line_element)
    line_layout = LLayout(layout_lines + visual_elements)
    line_layout.sort_by_bbox()
    return line_layout


def match_interval(word: Word, prev_word: Word, threshold: float) -> bool:
    """Check if word is in the same line as prev_word
    based on threshold and vertical metadata"""
    if word.metadata.get("vertical", None):
        return not (
            word.x0 > prev_word.x0 + (prev_word.x1 - prev_word.x0) * threshold
            or word.x1 < prev_word.x1 - (prev_word.x1 - prev_word.x0) * threshold
        )
    return not (
        word.y0 > prev_word.y0 + (prev_word.y1 - prev_word.y0) * threshold
        or word.y1 < prev_word.y1 - (prev_word.y1 - prev_word.y0) * threshold
    )


def build_lines_from_ocr_order(
    layout_ocr: WLayout, threshold: float, *_args
) -> LLayout:
    """Build lines from words:
    - sort words by bbox
    - iterate words and set new line when x1 is smaller than previous x0
        or word.y is not in previous y interval based on threshold
        or word is vertical and previous word is not vertical or vice versa"""
    layout_lines: list[Line | None] = []
    for words in layout_ocr.iterate_elements_by_page:
        if not words:
            continue
        prev_word = None
        # init first line
        line = Line.create(
            x0=words[0].x0,
            x1=words[0].x1,
            y0=words[0].y0,
            y1=words[0].y1,
            content=[words[0]],
            page=words[0].page,
            extractor=words[0].extractor,
        )
        # iterate words to build lines
        for word in words[1:]:
            if prev_word is not None and (
                word.x1 < prev_word.x0
                or not match_interval(word, prev_word, threshold)
                or (
                    word.metadata.get("vertical", None)
                    != prev_word.metadata.get("vertical", None)
                )
            ):
                layout_lines.append(line)
                line = Line.create(
                    x0=word.x0,
                    x1=word.x1,
                    y0=word.y0,
                    y1=word.y1,
                    content=[word],
                    page=word.page,
                    extractor=word.extractor,
                )
            elif line is not None:
                line.x0 = min(line.x0, word.x0)
                line.x1 = max(line.x1, word.x1)
                line.y0 = min(line.y0, word.y0)
                line.y1 = max(line.y1, word.y1)
                line.content.append(word)
            prev_word = word
        # add last line
        layout_lines.append(line)
    return LLayout(list(filter(None, layout_lines)))
