# BD Troubleshooting Guide

**Purpose:** Real-world learnings from debugging bd issues. Use this when bd doctor shows warnings.

**When to read:** When bd doctor fails or shows confusing warnings.

**Quick access:** User can invoke `/proc-beads` command in Claude Code to automatically load this guide and run diagnostics.

---

## Critical Understanding: Sync-Branch Architecture

**Most Important Concept:** In sync-branch mode, there are TWO different JSONL files:

1. **Working Tree** `.beads/issues.jsonl`
   - May be stale/incomplete
   - Used for display in working tree only
   - NOT the source of truth

2. **Sync Branch** `beads-metatdata` branch `.beads/issues.jsonl`
   - Lives in `.git/beads-worktrees/beads-metatdata/.beads/issues.jsonl`
   - The actual source of truth
   - Database syncs from here

**Why this matters:** bd doctor warnings like "Count mismatch: database has 81 issues, JSONL has 58" are often **false positives** - doctor checks working tree JSONL instead of sync branch JSONL.

---

## Session Start Workflow

When bd doctor shows issues at session start:

### 1. Check Actual Database State First

```bash
# Don't trust doctor warnings alone - verify database works
bd stats                    # Shows total issues, open/closed breakdown
bd --no-daemon ready        # Shows ready work
bd --no-daemon list --status open | head -5
```

**If these commands work and show reasonable data, the database is probably fine.**

### 2. Understand the Warning Context

Common false positives in sync-branch mode:

**"DB-JSONL Sync: Count mismatch: database has 81 issues, JSONL has 58"**
- ✅ Expected if using sync-branch mode
- Check: `wc -l .beads/issues.jsonl` (working tree, may be stale)
- Check: `wc -l .git/beads-worktrees/beads-metatdata/.beads/issues.jsonl` (sync branch, truth)
- **Action:** If database == sync branch JSONL, ignore this warning

**"Sync Divergence: JSONL is newer than last import"**
- ✅ Expected in sync-branch mode after git operations
- Database will auto-import on next command
- **Action:** Run `bd sync --import-only` if you want to clear it now

**"Git Working Tree: Uncommitted changes present"**
- ⚠️ Informational - not a bd problem
- Just means there are untracked files in repo
- **Action:** Only fix if planning to commit work

### 3. Real Problems That Need Fixing

**"CLI Version: 0.X.Y (latest: 0.Z.W)"**
- ❌ Critical - version mismatch causes issues
- **Action:** Run upgrade script immediately
  ```bash
  curl -fsSL https://raw.githubusercontent.com/steveyegge/beads/main/scripts/install.sh | bash
  ```

**"Database version: 0.X.Y (CLI: 0.Z.W)"**
- ❌ Critical - database needs migration
- **Action:** `bd migrate` after upgrading CLI

**"Daemon Health: Version mismatch" or "Stale socket"**
- ❌ Critical - daemon issues cause corruption
- **Action:**
  ```bash
  bd daemons killall
  bd daemon start
  ```

**"Database Integrity: Corruption detected"**
- ❌ Critical - data corruption
- **Action:** Restore from git history or JSONL

---

## Common Pitfalls & Solutions

### Pitfall 1: Default Filters Hide Data

**Symptom:** `bd list | wc -l` shows 26 but doctor says 81 issues exist

**Cause:** `bd list` defaults to open issues only

**Solution:** Always check `bd stats` first for full picture
```bash
bd stats                              # Shows total breakdown
bd list --status open | wc -l         # Open only (default)
bd list --status closed | wc -l       # Closed only
```

### Pitfall 2: Multiple BD Installations

**Symptom:** After upgrade, old version still runs or weird errors occur

**Cause:** Multiple bd executables in PATH

**Check:**
```bash
which -a bd
# Should show only one: /home/user/.local/bin/bd
```

**Solution:** Remove old installations
```bash
# If found in /usr/local/lib/node_modules:
sudo npm uninstall -g @beads/bd

# If found elsewhere, manually remove
```

### Pitfall 3: Confusing Export/Import vs Sync

**When to use each:**

- `bd export` - Low-level dump database → JSONL (rarely needed manually)
- `bd import` - Low-level load JSONL → database (rarely needed manually)
- `bd sync` - High-level full workflow: export + commit + pull + import + push ✅ **Use this**

**Special cases:**
- `bd sync --import-only` - Just import from sync branch (after git pull)
- `bd import --force` - Updates metadata timestamps (not data) for staleness checks

### Pitfall 4: Treating All Doctor Warnings as Critical

**Reality check:**
- Some warnings are **false positives** (sync-branch JSONL comparison)
- Some are **informational** (uncommitted files, sync divergence)
- Some are **critical** (version mismatches, corruption)

**Strategy:**
1. Run `bd stats` and `bd ready` first
2. If those work, most warnings are probably safe to ignore
3. Only fix critical warnings (versions, corruption, daemon issues)

### Pitfall 5: Force Flags Don't Force Data Re-import

**Symptom:** `bd import --force` says "0 created, 0 updated" even though you expected changes

**Cause:** `--force` updates **metadata** (timestamps), not data. bd only imports issues that are newer or different.

**Solution:** If you need to force data refresh, delete the database and reimport:
```bash
# DANGEROUS - only if database is truly corrupted
mv .beads/beads.db .beads/beads.db.backup
bd init  # Will reimport from sync branch
```

---

## Quick Reference: Session Start Checklist

When bd doctor shows warnings:

```
✅ 1. Check if database actually works
   - bd stats (shows issue counts)
   - bd ready (shows available work)
   - bd --no-daemon list --status open (list opens)

✅ 2. Identify critical vs informational warnings
   - Version mismatches → Fix immediately
   - Sync divergence in sync-branch mode → Usually safe to ignore
   - DB-JSONL count mismatch → Check sync branch JSONL, not working tree

✅ 3. Fix only critical issues
   - Upgrade CLI if version mismatch
   - Migrate database if schema mismatch
   - Restart daemon if daemon health issues

✅ 4. Ignore false positives
   - "Count mismatch" when sync branch matches database
   - "Sync divergence" after git operations
   - "Uncommitted changes" (not a bd issue)

✅ 5. Report status to user
   - "bd is working correctly despite X warnings (false positives)"
   - OR "Fixed critical issue Y, bd now healthy"
   - Show bd ready output (what work is available)
```

---

## Advanced: Understanding Staleness Checks

bd tracks JSONL modification time and last import time to detect when database is stale.

**Staleness workflow:**
1. You run `git pull` → sync branch JSONL updates
2. JSONL mtime is now > last import time
3. bd detects staleness and refuses commands
4. You run `bd sync --import-only` → imports updates
5. Last import time updated → staleness cleared

**Escape hatch (use carefully):**
```bash
bd --allow-stale ready    # Skip staleness check - may show stale data
bd --sandbox ready        # Direct mode, no daemon, no auto-import
```

---

## When to Escalate to User

Ask user for help when:

1. **Database truly corrupted** (bd stats fails, sqlite errors)
2. **Upgrade fails** (permission errors, network issues)
3. **Circular git conflicts** (sync branch has conflicts)
4. **Unknown errors** (not covered in this guide)

Don't ask user when:
- False positive warnings in sync-branch mode
- Informational warnings (uncommitted files)
- Standard upgrade/migration needed (just do it)

---

## Summary: Key Insights

1. **Sync-branch mode has TWO JSONL files** - working tree (stale) vs sync branch (truth)
2. **bd stats is your friend** - always check before believing doctor warnings
3. **Not all warnings are critical** - learn to distinguish false positives
4. **bd sync is the main command** - rarely need export/import manually
5. **Version mismatches are critical** - everything else is usually fixable or ignorable
6. **Default filters hide data** - `bd list` shows open only, `bd stats` shows all
7. **Trust the database** - if bd ready/stats work, database is probably fine

**Most important:** When doctor shows warnings at session start, don't panic. Check if database actually works first with `bd stats` and `bd ready`. Many warnings are false positives in sync-branch mode.
