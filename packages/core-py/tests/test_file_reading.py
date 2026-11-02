import os
import shutil
from pathlib import Path

import pytest

from astropods_adapter_core import (
    PAGE_CHARS,
    PAGE_ROWS,
    attach_file,
    attachment_note,
    create_file,
    inspect_file,
    read_file_page,
    read_table,
    resolve_agent_file,
)
from astropods_adapter_core.files import run_in_turn
from astropods_adapter_core.types import AttachmentInput, ImageInput

FIXTURES = Path(__file__).resolve().parents[2] / "core" / "tests" / "fixtures" / "files"
STAGED = ["plan-pdf", "plan-docx", "pipeline", "scan", "deals", "long", "excel-utf8"]


@pytest.fixture
def files_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("AGENT_FILES_DIR", str(tmp_path))
    # Staged uploads carry no extension, so the copies drop theirs too.
    shutil.copy(FIXTURES / "account-plan.pdf", tmp_path / "plan-pdf.blob")
    shutil.copy(FIXTURES / "account-plan.docx", tmp_path / "plan-docx.blob")
    shutil.copy(FIXTURES / "pipeline.xlsx", tmp_path / "pipeline.blob")
    shutil.copy(FIXTURES / "scanned.pdf", tmp_path / "scan.blob")
    rows = ["id,account,stage,amount"] + [f"{i},Account {i % 97},Stage {i % 7},{i * 10}" for i in range(1, 5001)]
    (tmp_path / "deals.blob").write_text("\n".join(rows) + "\n")
    (tmp_path / "long.blob").write_text("x" * (PAGE_CHARS + 10))
    (tmp_path / "excel-utf8.blob").write_text("﻿Region,Amount\nWest,10\nEast,5\n")
    return tmp_path


@pytest.fixture
def in_turn(files_dir):
    with run_in_turn(lambda *f: None, attachments=[str(files_dir / f"{n}.blob") for n in STAGED]):
        yield files_dir


class TestInspectFile:
    def test_gives_a_csvs_columns_and_exact_row_count(self, in_turn):
        info = inspect_file(str(in_turn / "deals.blob"))
        assert info["kind"] == "text"
        assert info["tables"] == [{"columns": ["id", "account", "stage", "amount"], "rows": 5000}]

    def test_reads_the_first_column_of_a_csv_that_starts_with_a_byte_order_mark(self, in_turn):
        assert inspect_file(str(in_turn / "excel-utf8.blob"))["tables"][0]["columns"] == ["Region", "Amount"]

    def test_lists_every_xlsx_sheet(self, in_turn):
        info = inspect_file(str(in_turn / "pipeline.blob"))
        assert info["kind"] == "xlsx"
        assert [(t["name"], t["rows"]) for t in info["tables"]] == [("Pipeline", 3), ("Contacts", 2)]

    def test_sniffs_a_pdf_and_a_docx_without_an_extension(self, in_turn):
        assert inspect_file(str(in_turn / "plan-pdf.blob"))["kind"] == "pdf"
        assert inspect_file(str(in_turn / "plan-docx.blob"))["kind"] == "docx"


class TestScannedPdf:
    def test_inspect_file_flags_it_and_read_file_page_says_it_needs_ocr(self, in_turn):
        info = inspect_file(str(in_turn / "scan.blob"))
        assert (info["kind"], info["total_chars"], info["scanned"]) == ("pdf", 0, True)
        with pytest.raises(ValueError, match="no text layer"):
            read_file_page(str(in_turn / "scan.blob"))

    def test_a_pdf_with_text_is_not_flagged(self, in_turn):
        assert "scanned" not in inspect_file(str(in_turn / "plan-pdf.blob"))


class TestReadFilePage:
    def test_reads_a_pdfs_text(self, in_turn):
        page = read_file_page(str(in_turn / "plan-pdf.blob"))
        assert "Negotiation" in page["text"]
        assert page["next_offset"] is None

    def test_reads_a_docxs_text(self, in_turn):
        assert "Globex" in read_file_page(str(in_turn / "plan-docx.blob"))["text"]

    def test_pages_through_text_longer_than_one_page(self, in_turn):
        first = read_file_page(str(in_turn / "long.blob"))
        assert len(first["text"]) == PAGE_CHARS
        assert first["next_offset"] == PAGE_CHARS
        second = read_file_page(str(in_turn / "long.blob"), first["next_offset"])
        assert second == {"text": "x" * 10, "offset": PAGE_CHARS, "next_offset": None, "total_chars": PAGE_CHARS + 10}


class TestReadTable:
    def test_pages_through_every_row_of_a_csv(self, in_turn):
        first = read_table(str(in_turn / "deals.blob"))
        assert first["columns"] == ["id", "account", "stage", "amount"]
        assert len(first["rows"]) == PAGE_ROWS
        assert first["rows"][0] == ["1", "Account 1", "Stage 1", "10"]
        assert first["next_offset"] == PAGE_ROWS

        last = read_table(str(in_turn / "deals.blob"), offset=4998, limit=10)
        assert (last["offset"], last["next_offset"]) == (4998, None)
        assert [r[0] for r in last["rows"]] == ["4999", "5000"]

    def test_reads_a_named_xlsx_sheet(self, in_turn):
        page = read_table(str(in_turn / "pipeline.blob"), sheet="Contacts")
        assert page["columns"] == ["Account", "Name", "Role"]
        assert ["Acme Corp", "Dana Lee", "VP Engineering"] in page["rows"]
        with pytest.raises(ValueError, match="Sheets: Pipeline, Contacts"):
            read_table(str(in_turn / "pipeline.blob"), sheet="Missing")


class TestReadScope:
    def test_rejects_a_file_in_the_dir_that_the_turn_neither_received_nor_created(self, in_turn):
        (in_turn / "summary.md").write_text("another thread's summary")
        with pytest.raises(PermissionError, match="attached to or created in this conversation"):
            read_file_page(str(in_turn / "summary.md"))
        with pytest.raises(PermissionError):
            resolve_agent_file("/etc/passwd")

    def test_refuses_outside_a_turn(self, files_dir):
        with pytest.raises(RuntimeError, match="while the agent handles a message"):
            read_table(str(files_dir / "deals.blob"))

    def test_rejects_a_file_the_turn_attached_without_writing_it(self, files_dir):
        (files_dir / "report.md").write_text("another thread's report")
        with run_in_turn(lambda *f: None):
            attach_file("report.md")
            with pytest.raises(PermissionError):
                read_file_page(str(files_dir / "report.md"))

    def test_opens_a_file_from_an_earlier_turn_of_the_same_conversation_and_no_other_conversations(self, files_dir):
        with run_in_turn(lambda *f: None, conversation_id="thread-a", attachments=[str(files_dir / "deals.blob")]):
            attach_file("draft.md", "first draft")

        with run_in_turn(lambda *f: None, conversation_id="thread-a"):
            assert read_file_page(str(files_dir / "draft.md"))["text"] == "first draft"
            assert read_table(str(files_dir / "deals.blob"), limit=1)["rows"] == [["1", "Account 1", "Stage 1", "10"]]

        with run_in_turn(lambda *f: None, conversation_id="thread-b"):
            with pytest.raises(PermissionError):
                read_file_page(str(files_dir / "draft.md"))
            with pytest.raises(PermissionError):
                read_table(str(files_dir / "deals.blob"))

    def test_create_file_returns_a_path_the_conversations_next_turn_can_read(self, files_dir):
        (files_dir / "brief.md").write_text("another thread's brief")
        with run_in_turn(lambda *f: None, conversation_id="thread-c"):
            created = create_file("brief.md", "# Brief")
        assert created == {"attached": "brief-2.md", "path": os.path.join(str(files_dir), "brief-2.md")}
        with run_in_turn(lambda *f: None, conversation_id="thread-c"):
            assert read_file_page(created["path"])["text"] == "# Brief"


class TestAttachmentNote:
    def test_names_each_file_and_its_path_and_skips_inline_images(self):
        attachments = [
            AttachmentInput(key="k1", name="deals.csv", path="/data/files/k1.blob"),
            AttachmentInput(key="k2", name="shot.png", path="/data/files/k2.blob"),
            AttachmentInput(key="k3", name="old.csv"),
        ]
        note = attachment_note(attachments, [ImageInput(key="k2", name="shot.png", url="data:,")])
        assert note.endswith("deals.csv (/data/files/k1.blob)")
        assert "shot.png" not in note and "old.csv" not in note
        assert attachment_note([]) == ""
