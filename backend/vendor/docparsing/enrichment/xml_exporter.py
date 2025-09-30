"""Module to export a layout as an XML file"""

from typing import Literal
import logging
from defusedxml import defuse_stdlib
from pydantic import BaseModel, Field
from .hierarchy_utils import (
    set_element_caption,
    set_title_hierarchy,
    set_table_footnote,
    set_list_caption,
    set_paragraph_hierarchy,
    MAX_TITLE_SPLIT_CANDIDATE,
)
from .config import EnrichmentConfig
from ..schemas import PLayout, Paragraph, TableContent, ElementType, List, Image

# Make standard XML libraries secure
defuse_stdlib()
# using "nosec" to avoid bandit issue as it is fixed by calling defuse_stdlib() before the import
from xml.etree import ElementTree as ET  # nosec # pylint: disable=C0413, C0411 # noqa: E402

logger = logging.getLogger(__name__)


class XmlExporter(BaseModel):
    """Export layout elements to XML format

    Attributes
    ----------
    enrichment_config: EnrichmentConfig
        Enrichment configuration

    Methods:
    export_xml: Build a tree structure from a layout and return it as an ElementTree

    Examples
    --------
    ```python
    import io
    from docparsing.enrichment import XmlExporter
    from docparsing.extract import DoctrExtractor
    from docparsing.layout import DetectronLayoutExtractor
    from docparsing.structuration import DocumentBuilder

    # Extract OCR Layout from a PDF file
    extractor = DoctrExtractor()
    ocr_layout = extractor.extract_words(io.BytesIO(open("example.pdf", "rb"))

    # Extract Layout from a PDF file
    extractor = DetectronLayoutExtractor()
    layout = extractor.extract_elements(io.BytesIO(open("example.pdf", "rb"))

    # Build a structured document from a layout and an OCR layout
    builder = DocumentBuilder()
    structured_document = builder.build_document(ocr_layout, layout)

    # Create an XmlExporter instance
    exporter = XmlExporter()

    # Export layout as an XML file
    tree = exporter.export_xml(layout)
    tree.write("layout.xml")
    ```

    """

    enrichment_config: EnrichmentConfig = Field(
        default_factory=EnrichmentConfig,
        description="Enrichment configuration",
    )

    def _add_sub_element(
        self,
        parent: ET.Element,
        element: Paragraph | TableContent,
        split_level: int,
    ) -> ET.Element:
        """Add element to parent"""
        element_xml = None
        if isinstance(element, Paragraph):
            element_xml = ET.SubElement(parent, element.type.value)
            element_xml.set("split_candidate", str(split_level))
            element_xml.set("inferred", str(element.inferred))
            if element.is_vertical:
                element_xml.set("vertical", str(element.is_vertical))
            element_xml.set("pages", str(element.pages))
            element_xml.set("bboxes", str(element.get_bboxes(as_tuple=True)))
            if isinstance(element, Image):
                element_xml.set("id", str(element.id))
            # Content
            if isinstance(element, List):
                current_idx = 0
                item_idx = element.metadata.get("item_idx", [])
                desc_idx = element.metadata.get("desc_idx", [])
                for list_item in element.to_list():
                    list_item_xml = element_xml
                    if current_idx in item_idx:
                        list_item_xml = (
                            ET.SubElement(element_xml, "dd")
                            if desc_idx
                            else ET.SubElement(element_xml, "li")
                        )
                    elif current_idx in desc_idx:
                        list_item_xml = ET.SubElement(element_xml, "dt")
                    for word in list_item:
                        word_xml = ET.SubElement(list_item_xml, word.type.value)
                        word_xml.text = word.content
                        word_xml.set("fontname", word.metadata.get("fontname", ""))
                    current_idx += len(list_item)
            else:  # all other Paragraph types
                for word in element.content:
                    word_xml = ET.SubElement(element_xml, word.type.value)
                    word_xml.text = word.content
                    word_xml.set("fontname", word.metadata.get("fontname", ""))

        else:  # isinstance(element, TableContent):
            element_xml = ET.SubElement(parent, "table")
            element_xml.set("split_candidate", str(split_level))
            element_xml.set("pages", str(element.pages))
            element_xml.set("bboxes", str(element.get_bboxes(as_tuple=True)))
            if self.enrichment_config.xml_exporter_table_format == "latex":
                element_xml.text = element.to_latex()
            elif self.enrichment_config.xml_exporter_table_format == "html":
                list_spanning_cells, skip_idx = element.get_spanning_cells()
                current_idx = -1  # to start from 0 at first iteration
                for row in element.content:
                    row_xml = ET.SubElement(element_xml, "tr")
                    for cell in row:
                        current_idx += 1
                        # skip cells that are spanning cells and already processed
                        if current_idx in skip_idx:
                            continue
                        cell_xml = ET.SubElement(row_xml, "td")
                        # set rowspan and colspan if cell is a spanning cell
                        if current_idx in list_spanning_cells:
                            rowspan, colspan = list_spanning_cells[current_idx]
                            if rowspan > 1:
                                cell_xml.set("rowspan", str(rowspan))
                            if colspan > 1:
                                cell_xml.set("colspan", str(colspan))
                        cell_xml.text = cell
        return element_xml

    def _build_tree(
        self, layout: PLayout
    ) -> tuple[dict[int, list[int]], dict[int, int]]:
        """Make hierarchy from layout
        use type "title" to define parent and children
        return as a dict with title index as key and list of children indexes as value
        set split_candidate priority level for each element
        return as a dict with element index as key and split_candidate as value"""
        hierarchy: dict[int, list[int]] = {}
        split_candidate: dict[int, int] = {}
        current_title = None
        current_page = 0
        title_level = 0
        for position, element in enumerate(layout.root):
            if element.type not in [
                ElementType.TEXT,
                ElementType.LIST,
                ElementType.TITLE,
                ElementType.EXTRA,
                ElementType.HEADER,
                ElementType.FOOTER,
                ElementType.TABLE_CONTENT,
                ElementType.IMAGE,
            ]:
                continue
            hierarchy.setdefault(position, [])
            split_candidate.setdefault(position, MAX_TITLE_SPLIT_CANDIDATE + 1)
            if element.page != current_page:
                split_candidate[position] = 0
                # reset title level if page changes on a title
                if element.type == ElementType.TITLE:
                    title_level = 1
            if element.type == ElementType.TITLE:
                # hierarchy: for title element
                current_title, title_level = set_title_hierarchy(
                    element,
                    position,
                    hierarchy,
                    split_candidate,
                    current_title,
                    title_level,
                )
            else:
                # split_candidate: for table footnote
                set_table_footnote(layout, element, position, split_candidate)
                # hierarchy: look for caption for table, figure and formula
                if set_element_caption(
                    layout, element, position, hierarchy, split_candidate
                ):
                    pass
                # hierarchy: paragraph ending with ":" before a list
                elif set_list_caption(
                    layout, element, position, split_candidate, hierarchy
                ):
                    pass
                # hierarchy: after a title for any other element
                elif current_title is not None:
                    set_paragraph_hierarchy(
                        position,
                        split_candidate,
                        hierarchy,
                        current_title,
                    )
                # reset title level after a non-title element
                title_level = 1 if title_level != 0 else 0
            current_page = element.page
        # avoid gaps in split levels
        # default is MAX_TITLE_SPLIT_CANDIDATE+1 and max is MAX_TITLE_SPLIT_CANDIDATE+2)
        max_level = max(
            (v for v in split_candidate.values() if v < MAX_TITLE_SPLIT_CANDIDATE + 1),
            default=-1,
        )
        split_candidate = {
            k: (
                max_level + 1
                if v == MAX_TITLE_SPLIT_CANDIDATE + 1
                else (max_level + 2 if v == MAX_TITLE_SPLIT_CANDIDATE + 2 else v)
            )
            for k, v in split_candidate.items()
        }
        if not self.enrichment_config.allow_cross_page_nodes:
            # remove cross-page nodes
            for parent, children in hierarchy.items():
                child_to_remove: list[int] = []
                for child in children:
                    if layout.root[parent].page != layout.root[child].page:
                        child_to_remove.append(child)
                for child in child_to_remove:
                    children.remove(child)
        return hierarchy, split_candidate

    def _create_xml(
        self,
        current_elem: int,
        parent_xml: ET.Element,
        hierarchy: dict[int, list[int]],
        layout: PLayout,
        split_candidate: dict[int, int],
        position2xml: dict[int, ET.Element],
    ):
        """Create each elements as sub_element in the XML tree recursively"""
        if current_elem not in position2xml:
            current_elem_xml = self._add_sub_element(
                parent_xml, layout.root[current_elem], split_candidate[current_elem]
            )
            position2xml[current_elem] = current_elem_xml
        children = hierarchy[current_elem]
        for child in sorted(children):
            # create sub_element for each child
            self._create_xml(
                child,
                position2xml[current_elem],
                hierarchy,
                layout,
                split_candidate,
                position2xml,
            )

    def export_xml(
        self, layout: PLayout, table_format: Literal["latex", "html"] | None = None
    ) -> ET.ElementTree:
        """Build a tree structure from a layout and return it as an ElementTree

        Parameters
        ----------
        layout: PLayout
            Layout to build a tree structure from

        Returns
        -------
        ET.ElementTree
            Tree structure of the layout as an ElementTree (XML)
        """
        if table_format is not None:
            self.enrichment_config.xml_exporter_table_format = table_format
        layout_xml = ET.Element("layout")
        hierarchy, split_candidate = self._build_tree(layout)
        position2xml: dict[int, ET.Element] = {}
        is_child = set(sum(hierarchy.values(), []))  # list of all children
        # iterate over all elements in the layout ordered by their position
        for current_elem in sorted(hierarchy):
            if current_elem in is_child:
                # skip elements that are children of other elements
                # to ensure that the parent is created first
                continue
            self._create_xml(
                current_elem,
                layout_xml,
                hierarchy,
                layout,
                split_candidate,
                position2xml,
            )
        tree = ET.ElementTree(layout_xml)
        ET.indent(tree, space="    ")
        return tree
