#!/usr/bin/env python3
"""
Scoped, isolated filesystem executor for R2 (see
docs/plans/2026-09-22-review-remediation.md). This is the ONLY thing that
actually writes a file under a managed root: every intermediate path
component is opened relative to the PREVIOUSLY VERIFIED parent directory's
own file descriptor, using O_NOFOLLOW, so a symlink substituted into any
ancestor directory AT ANY POINT before this process starts (or, for an
already-open fd, after a component has been verified and descended into)
cannot redirect the write to a different, attacker-chosen location.

This is deliberately narrow: it does exactly one thing (verify a path
component-by-component via descriptor-relative syscalls, then atomically
write and rename within the final verified directory's fd) and nothing
else. It is invoked once per managed write by packages/cli/src/paths.ts,
which is the only caller and is responsible for validating that every
argv component is a single path segment before invoking this script.

Protocol:
  argv: <root> <expected-preimage-digest-or-"-"> [<intermediate-component> ...] <final-component>
  stdin: the raw bytes to write (read fully before any filesystem action)
  stdout on success: "OK <bytesWritten>"
  stderr + nonzero exit on failure: "<REASON_CODE>:<detail>"

expected-preimage-digest is either "-" (skip the check), "absent" (the
caller expects no file exists there yet), or a lowercase hex sha256 of the
expected CURRENT content. The check happens inside the SAME verified fd
chain, immediately before the write — never a separate, earlier, re-racable
step — so a concurrent edit AND a concurrent symlink swap are both bound to
execution by the same boundary.

Exit codes: 2 root open failed, 3 a component is a symlink or non-directory,
4 the final component is an existing symlink, 5 the final component exists
but is not a regular file, 6 an argv component is not a single safe path
segment, 7 unexpected OS error during the write/rename itself, 8 the
existing content's digest did not match expected-preimage-digest.

Requires a platform where Python's `os` module supports dir_fd for open,
mkdir, rename, and stat, and follow_symlinks=False for stat (verified by
the caller via --probe before ever relying on this script for a real
write). On a platform without that support, the caller must treat managed
writes as unavailable and refuse execution — this script does not attempt
a lesser-safety fallback.
"""
import hashlib
import os
import stat
import sys


def fail(code, msg):
    sys.stderr.write(msg + "\n")
    sys.exit(code)


def is_safe_component(name):
    return name not in ("", ".", "..") and "/" not in name and "\0" not in name


def probe():
    required_dir_fd = (os.open, os.mkdir, os.rename, os.stat, os.unlink, os.chmod)
    ok = all(fn in os.supports_dir_fd for fn in required_dir_fd) and os.stat in os.supports_follow_symlinks
    sys.exit(0 if ok else 1)


def main():
    if len(sys.argv) >= 2 and sys.argv[1] == "--probe":
        probe()
        return

    args = sys.argv[1:]
    if len(args) < 3:
        fail(1, "USAGE: root expected_digest_or_dash [components...] final_name  (content on stdin)")
    root = args[0]
    expected_digest = args[1]
    final_name = args[-1]
    components = args[2:-1]

    for comp in components + [final_name]:
        if not is_safe_component(comp):
            fail(6, "INVALID_COMPONENT:%s" % comp)

    content = sys.stdin.buffer.read()

    try:
        dir_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
    except OSError as e:
        fail(2, "ROOT_OPEN_FAILED:%s" % e)

    try:
        for comp in components:
            try:
                st = os.stat(comp, dir_fd=dir_fd, follow_symlinks=False)
            except FileNotFoundError:
                # Does not exist yet — create it as a real directory, then
                # verify what we just created before trusting it (a
                # concurrent actor could in principle have raced us between
                # mkdir and stat; re-stat closes that, and the subsequent
                # O_NOFOLLOW open is what actually enforces it atomically).
                try:
                    os.mkdir(comp, dir_fd=dir_fd)
                except FileExistsError:
                    pass
                st = os.stat(comp, dir_fd=dir_fd, follow_symlinks=False)
            if stat.S_ISLNK(st.st_mode) or not stat.S_ISDIR(st.st_mode):
                fail(3, "SYMLINK_OR_NON_DIR:%s" % comp)
            new_fd = os.open(comp, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=dir_fd)
            os.close(dir_fd)
            dir_fd = new_fd

        mode = None
        existed = False
        try:
            st = os.stat(final_name, dir_fd=dir_fd, follow_symlinks=False)
            if stat.S_ISLNK(st.st_mode):
                fail(4, "FINAL_IS_SYMLINK:%s" % final_name)
            if not stat.S_ISREG(st.st_mode):
                fail(5, "FINAL_NOT_REGULAR:%s" % final_name)
            mode = st.st_mode & 0o777
            existed = True
        except FileNotFoundError:
            pass

        if expected_digest != "-":
            if not existed:
                if expected_digest != "absent":
                    fail(8, "PREIMAGE_MISMATCH:expected %s but no file exists" % expected_digest)
            else:
                # Read via the SAME verified dir_fd, O_NOFOLLOW again as
                # defense in depth even though the preceding stat already
                # confirmed a regular file — never a path-based reopen.
                read_fd = os.open(final_name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=dir_fd)
                try:
                    hasher = hashlib.sha256()
                    with os.fdopen(read_fd, "rb", closefd=True) as rf:
                        for chunk in iter(lambda: rf.read(1024 * 1024), b""):
                            hasher.update(chunk)
                    actual_digest = hasher.hexdigest()
                except BaseException:
                    raise
                if expected_digest == "absent" or actual_digest != expected_digest:
                    fail(8, "PREIMAGE_MISMATCH:expected %s but found %s" % (expected_digest, actual_digest))

        tmp_name = ".%s.%d.tmp" % (final_name, os.getpid())
        try:
            fd = os.open(tmp_name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=dir_fd)
        except OSError as e:
            fail(7, "TMP_CREATE_FAILED:%s" % e)
        try:
            with os.fdopen(fd, "wb", closefd=True) as f:
                f.write(content)
                f.flush()
                os.fsync(f.fileno())
            if mode is not None:
                os.chmod(tmp_name, mode, dir_fd=dir_fd)
            os.rename(tmp_name, final_name, src_dir_fd=dir_fd, dst_dir_fd=dir_fd)
        except OSError as e:
            try:
                os.unlink(tmp_name, dir_fd=dir_fd)
            except OSError:
                pass
            fail(7, "WRITE_OR_RENAME_FAILED:%s" % e)

        print("OK %d" % len(content))
    finally:
        try:
            os.close(dir_fd)
        except OSError:
            pass


main()
