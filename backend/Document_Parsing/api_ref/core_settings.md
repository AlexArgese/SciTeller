# `Core Settings for Docparsing Jobs`

## Core Settings

| Attribute  | Type | Description | Default |
|-----------|------|-------------|---------|
| **Default Job Settings** |  |  |  |
| `file_path` | `str` | `Path to the PDF file.` | PydanticUndefined |
| `output_dir` | `str` | `Output directory.` | . |
| `output_format` | `'xml', 'json', 'md', 'str'` | `Output format.` | json |
| `batch_size` | `int` | `Number of pages per batch while processing the PDF. 0 to process the entire PDF at once.` | 2 |
| `use_doctr` | `bool` | `Directly use DoctrExtractor instead of PdfPlumberExtractor without trying PdfPlumberExtractor first.` | False |
| `use_detectron2` | `bool` | `Use Detectron2Extractor for layout extraction.` | False |
| `use_yolo` | `bool` | `Use YOLOv10Extractor for layout extraction.` | True |
| `use_tatr` | `bool` | `Use TatrLayoutExtractor for table extraction.` | True |
| **YOLO Settings** |  |  |  |
| `yolo.threshold` | `float` | `Confidence threshold for layout elements.` | 0.5 |
| `yolo_extractor.grayscale` | `bool` | `Convert image to grayscale.` | False |
| **TATR Settings** |  |  |  |
| `tatr.table_threshold` | `float` | `Threshold for table detection confidence.` | 0.5 |
| `tatr_extractor.grayscale` | `bool` | `Convert image to grayscale.` | False |
| `tatr_extractor.spanning_cell_overlap_threshold` | `float` | `Threshold for spanning cell overlap.` | 0.5 |
| **Document Builder Settings** |  |  |  |
| `document_builder.build_lines_method` | `'bbox', 'ocr_order'` | `Method to build lines.` | bbox |
| `document_builder.regex_chapters` | `list` | `List of regex patterns to detect chapters.` | PydanticUndefined |
| `document_builder.threshold_word_in_line` | `float` | `Threshold to determine whether a word is in a line when using the 'bbox' build_lines_method.` | 0.6 |
| `document_builder.threshold_word_in_paragraph` | `float` | `Threshold to determine whether a word is in a paragraph when processing : populate_paragraphs().` | 0.25 |
| `document_builder.threshold_word_in_table` | `float` | `Threshold to determine whether a word is in a table when processing : populate_tables().` | 0.5 |
| **Enrichment Settings** |  |  |  |
| `enrichment_config.document_language` | `'auto', 'en', 'fr'` | `Language of the document, Used by WordNinja to set the dictionary for word splitting after word merge. auto: auto-detect the language with py3langid` | auto |
| `enrichment_config.regex_num_starter` | `Pattern` | `Regular expression to match numbers at the start` | PydanticUndefined |
| `enrichment_config.vertical_paragraph_anchor` | `'top', 'bottom', 'y0', False` | `Where to anchor vertical paragraphs in the layout: 'top', 'bottom', 'y0', False` | False |
| `enrichment_config.extractor_list_update_policy` | `True, 'yolo', False` | `Which extractor to check before updating the element type from text to list: True, 'yolo', False` | yolo |
| `enrichment_config.word_merge_policy` | `True, 'vertical', False` | `Which policy for merging exploded words: True, 'vertical', False` | True |
| `enrichment_config.split_long_words` | `bool` | `Split long words into smaller parts` | False |
| `enrichment_config.allow_cross_page_nodes` | `bool` | `Allow cross-page nodes in the tree structure` | True |
| `enrichment_config.normalize_form` | `False, 'NFC', 'NFD', 'NFKC', 'NFKD'` | `Normalization form for the text: 'NFC' or 'NFD' or 'NFKC' or 'NFKD'` | NFD |
| `enrichment_config.remove_extra` | `True, 'header', 'footer', False` | `Target for removing extra elements: True, 'header', 'footer', False` | False |
| `enrichment_config.remove_extra_pattern` | `list` | `Regular expressions to match extra elements to remove` | PydanticUndefined |
| `enrichment_config.markdown_exporter_table_format` | `'latex', 'markdown'` | `Table format for markdown exporter: 'latex' or 'markdown'` | markdown |
| `enrichment_config.xml_exporter_table_format` | `'latex', 'html'` | `Table format for XML exporter: 'latex' or 'html'` | html |
| `enrichment_config.join_consecutive_text` | `bool` | `Join consecutive text elements into a single element based on conditions` | False |
| `enrichment_config.join_consecutive_list` | `bool` | `Join consecutive list elements into a single element based on conditions` | False |
| `enrichment_config.join_consecutive_table` | `bool` | `Join consecutive table elements into a single element based on conditions` | False |
| **Debug Job Settings** |  |  |  |
| `layout_ocr` | `bool` | `Visualize OCR layout predicted by OCR model.` | False |
| `layout_tatr` | `bool` | `Visualize Table layout predicted by TATR model.` | False |
| `layout_detectron` | `bool` | `Visualize layout predicted by Detectron model.` | False |
| `layout_yolo` | `bool` | `Visualize layout predicted by Yolo model.` | False |
| `document` | `bool` | `Visualize the final document.` | False |
| `pages` | `list` | `List of pages to visualize.` | PydanticUndefined |
| **Visualization Settings** |  |  |  |
| `visualize.columns` | `bool` | `Whether to draw the columns of space.` | False |
| `visualize.word_from_paragraph` | `bool` | `Whether to draw the words bbox inside the paragraphs.` | False |
| `visualize.draw_ocr_index` | `bool` | `Whether to draw the OCR index of the words.` | False |
| `visualize.ocr_index_step` | `int` | `Step to draw the OCR index of the words.` | 10 |
