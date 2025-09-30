"""Rules to handle the hierarchy and split candidate of elements in a document layout."""

from ..schemas import ElementType, Paragraph, PLayout, AutoPlayoutElement

MAX_TITLE_SPLIT_CANDIDATE = 6
MIN_SPLIT_CANDIDATE_PARAGRAPH = 4


def _set_hierarchy_with_next_caption(
    position: int,
    hierarchy: dict[int, list[int]],
    split_candidate: dict[int, int],
) -> None:
    """set hierarchy and split_candidate for caption after an element"""
    hierarchy.setdefault(position + 1, [])
    hierarchy[position + 1].append(position)
    # to ensure the caption is >= 0 (cause we apply -1 on it)
    split_candidate[position] += 1
    # the caption will be positioned before the element in XML and MD
    # so split_candidate should be higher on table than on caption
    split_candidate[position + 1] = min(
        split_candidate.get(position + 1, MAX_TITLE_SPLIT_CANDIDATE + 1),
        split_candidate[position] - 1,
    )


def set_element_caption(
    layout: PLayout,
    element: AutoPlayoutElement,
    position: int,
    hierarchy: dict[int, list[int]],
    split_candidate: dict[int, int],
) -> bool:
    """link an element to it's caption if exist (one caption for one element)
    (labels : table_caption / figure_caption / formula_caption)
    and manage split_candidate for captions
    return True if a caption is found and False otherwise"""
    # TODO: allow multiple element for one caption
    if element.type == ElementType.TABLE_CONTENT:
        if (
            position > 0
            # previous element is a table caption
            and layout.root[position - 1].label == "table_caption"
            # and the caption is not already parent of a table (from previous element)
            and position - 2 not in hierarchy[position - 1]
        ):
            hierarchy[position - 1].append(position)
            split_candidate[position] = split_candidate[position - 1] + 1
            return True
        if (
            len(layout.root) > position + 1
            # next element is a table caption
            and layout.root[position + 1].label == "table_caption"
        ):
            _set_hierarchy_with_next_caption(position, hierarchy, split_candidate)
            return True
    if element.type == ElementType.IMAGE:
        if (
            position > 0
            # previous element is a figure caption
            and layout.root[position - 1].label == "figure_caption"
            # and the caption is not already parent of a figure (from previous element)
            and position - 2 not in hierarchy[position - 1]
        ):
            hierarchy[position - 1].append(position)
            split_candidate[position] = split_candidate[position - 1] + 1
            return True
        if (
            len(layout.root) > position + 1
            # next element is a figure caption
            and layout.root[position + 1].label == "figure_caption"
        ):
            _set_hierarchy_with_next_caption(position, hierarchy, split_candidate)
            return True
    if element.label == "isolate_formula":
        if (
            position > 0
            # previous element is a formula caption
            and layout.root[position - 1].label == "formula_caption"
            # and the caption is not already parent of a formula (from previous element)
            and position - 2 not in hierarchy[position - 1]
        ):
            hierarchy[position - 1].append(position)
            split_candidate[position] = split_candidate[position - 1] + 1
            return True
        if (
            len(layout.root) > position + 1
            # next element is a formula caption
            and layout.root[position + 1].label == "formula_caption"
        ):
            _set_hierarchy_with_next_caption(position, hierarchy, split_candidate)
            return True
    return False


def set_title_hierarchy(
    element: AutoPlayoutElement,
    position: int,
    hierarchy: dict[int, list[int]],
    split_candidate: dict[int, int],
    current_title: int | None,
    title_level: int,
) -> tuple[int | None, int]:
    """manage hierarchy and split_candidate of Title elements"""
    # title are child of title only if following directly
    # (no other element in between)
    # except for elem_caption that are child of previous title
    if current_title is not None and (
        current_title == position - 1  # two following titles
        or element.label
        in [
            "table_caption",
            "figure_caption",
            "formula_caption",
        ]
    ):
        hierarchy[current_title].append(position)
        # min() to keep the lowest split_candidate (if already set in set_element_caption())
        split_candidate[position] = min(
            split_candidate[position], split_candidate[current_title] + 1
        )
        # don't increment title level with caption
        if element.label not in [  # meaning two following titles
            "table_caption",
            "figure_caption",
            "formula_caption",
        ]:
            title_level += 1
    # update split candidate
    split_candidate[position] = min(
        split_candidate[position], title_level, MAX_TITLE_SPLIT_CANDIDATE
    )
    if current_title is None:
        title_level = 1
    # update current title except for captions
    # (they will be set as title of their specific element in set_element_caption())
    if element.label not in [
        "table_caption",
        "figure_caption",
        "formula_caption",
    ]:
        current_title = position
    return current_title, title_level


def set_table_footnote(
    layout: PLayout,
    element: AutoPlayoutElement,
    position: int,
    split_candidate: dict[int, int],
) -> None:
    """manage split_candidate for labels : table_footnote"""
    # update split candidate for table footnotes
    if (
        element.label == "table_footnote"
        and position > 0
        and layout.root[position - 1].type == ElementType.TABLE_CONTENT
    ):
        split_candidate[position] = split_candidate[position - 1] + 1


def set_list_caption(
    layout: PLayout,
    element: AutoPlayoutElement,
    position: int,
    split_candidate: dict[int, int],
    hierarchy: dict[int, list[int]],
) -> bool:
    """manage split_candidate for paragraphs ending with ":" before a list"""
    if (
        element.type == ElementType.LIST
        and position > 0
        and isinstance(layout.root[position - 1], Paragraph)
        and layout.root[position - 1].content[-1].content.endswith(":")
    ):
        split_candidate[position] = split_candidate[position - 1] + 1
        hierarchy[position - 1].append(position)
        return True
    return False


def set_paragraph_hierarchy(
    position: int,
    split_candidate: dict[int, int],
    hierarchy: dict[int, list[int]],
    current_title: int,
) -> None:
    """manage split_candidate for paragraphs"""
    # paragraph hierarchy after a title
    hierarchy[current_title].append(position)
    # ensure split candidate of non-title elements is at least MIN_SPLIT_CANDIDATE_PARAGRAPH
    # unless it is already set to 0 (because new page)
    if split_candidate[position] != 0:
        split_candidate[position] = max(
            split_candidate[current_title] + 1, MIN_SPLIT_CANDIDATE_PARAGRAPH
        )
