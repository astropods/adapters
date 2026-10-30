import asyncio
import os

import pytest

from astropods_adapter_core import attach_file
from astropods_adapter_core.files import run_in_turn


@pytest.fixture
def files_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("AGENT_FILES_DIR", str(tmp_path))
    monkeypatch.delenv("FILES_MAX_MB", raising=False)
    return tmp_path


class TestAttachFile:
    async def test_writes_the_bytes_and_attaches_the_file(self, files_dir):
        files = []
        with run_in_turn(lambda *f: files.append(f)):
            await asyncio.sleep(0)
            attach_file("plan.csv", "account,arr\n", "text/csv")

        assert files == [("plan.csv", "text/csv", 12)]
        assert (files_dir / "plan.csv").read_text() == "account,arr\n"

    def test_attaches_a_file_already_in_the_files_dir(self, files_dir):
        (files_dir / "report.pdf").write_bytes(b"\x01\x02\x03")
        files = []
        with run_in_turn(lambda *f: files.append(f)):
            attach_file("report.pdf")

        assert files == [("report.pdf", None, 3)]

    async def test_reaches_a_tool_run_in_a_task_or_thread(self, files_dir):
        files = []

        async def in_task():
            attach_file("task.txt", b"t")

        def in_thread():
            attach_file("thread.txt", b"t")

        with run_in_turn(lambda *f: files.append(f)):
            await asyncio.create_task(in_task())
            await asyncio.to_thread(in_thread)

        assert [f[0] for f in files] == ["task.txt", "thread.txt"]

    async def test_keeps_concurrent_turns_apart(self, files_dir):
        a, b = [], []

        async def turn(sink, name, delay):
            with run_in_turn(lambda *f: sink.append(f)):
                await asyncio.sleep(delay)
                attach_file(name, b"x")

        await asyncio.gather(turn(a, "a.txt", 0.01), turn(b, "b.txt", 0))

        assert [f[0] for f in a] == ["a.txt"]
        assert [f[0] for f in b] == ["b.txt"]

    def test_raises_outside_a_turn(self, files_dir):
        with pytest.raises(RuntimeError, match="while the agent handles a message"):
            attach_file("x.txt", b"x")

    @pytest.mark.parametrize("name", ["", "..", "../x.txt", "sub/x.txt"])
    def test_rejects_a_name_that_is_not_one_path_segment(self, files_dir, name):
        with run_in_turn(lambda *f: None), pytest.raises(ValueError, match="invalid file name"):
            attach_file(name, b"x")
        assert os.listdir(files_dir) == []

    @pytest.mark.parametrize("name", ["slack-F1.blob", "summary.md.meta.json", "upload.tmp"])
    def test_rejects_a_name_the_messaging_sidecar_keeps(self, files_dir, name):
        with run_in_turn(lambda *f: None), pytest.raises(ValueError, match="cannot end in"):
            attach_file(name, b"x")
        assert os.listdir(files_dir) == []

    def test_keeps_the_bytes_of_a_file_already_in_the_files_dir(self, files_dir):
        (files_dir / "summary.md").write_text("first user's report")
        files = []
        with run_in_turn(lambda *f: files.append(f)), pytest.raises(FileExistsError, match="already exists"):
            attach_file("summary.md", "second user's report")

        assert files == []
        assert (files_dir / "summary.md").read_text() == "first user's report"

    def test_rejects_a_file_over_files_max_mb_before_writing_it(self, files_dir, monkeypatch):
        monkeypatch.setenv("FILES_MAX_MB", "1")
        files = []
        with run_in_turn(lambda *f: files.append(f)), pytest.raises(
            ValueError, match="big.csv is larger than the 1 MiB file size limit"
        ):
            attach_file("big.csv", b"x" * ((1 << 20) + 1))

        assert files == []
        assert os.listdir(files_dir) == []

    def test_limits_an_existing_file_to_100_mib_unless_files_max_mb_is_0(self, files_dir, monkeypatch):
        size = (100 << 20) + 1
        # Sparse, so the test passes the default without writing 100 MiB.
        with open(files_dir / "export.csv", "wb") as f:
            f.truncate(size)
        with run_in_turn(lambda *f: None), pytest.raises(ValueError, match="100 MiB"):
            attach_file("export.csv")

        monkeypatch.setenv("FILES_MAX_MB", "0")
        files = []
        with run_in_turn(lambda *f: files.append(f)):
            attach_file("export.csv")
        assert files == [("export.csv", None, size)]

    def test_rejects_a_missing_file_when_no_data_is_given(self, files_dir):
        with run_in_turn(lambda *f: None), pytest.raises(FileNotFoundError):
            attach_file("missing.pdf")
