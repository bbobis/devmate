#Requires -Version 7.0
<#
.SYNOPSIS
    Creates GitHub issues from issues.json using the GitHub CLI.
.DESCRIPTION
    Reads issues.json from the repo root, then for each entry calls
    `gh issue create` with the title and body, writing the body to a temp
    file to avoid quoting/escaping problems with large Markdown content.
.PARAMETER Repo
    GitHub repository in owner/name format. Defaults to LP-GTM-Product-Engineering/devmate.
.PARAMETER IssuesFile
    Path to the issues JSON file. Defaults to issues.json in the same directory as this script.
.PARAMETER DryRun
    If set, prints what would be created without calling gh.
#>
param(
    [string]$Repo = 'LP-GTM-Product-Engineering/devmate',
    [string]$IssuesFile = (Join-Path $PSScriptRoot 'issues.json'),
    [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ── Resolve and validate the issues file ─────────────────────────────────────
$issuesPath = Resolve-Path $IssuesFile
$issues = Get-Content -Raw -Path $issuesPath | ConvertFrom-Json

if (-not $issues -or $issues.Count -eq 0) {
    Write-Error "No issues found in $issuesPath"
    exit 1
}

Write-Host "Found $($issues.Count) issue(s) in $issuesPath"
Write-Host "Target repo: $Repo"
if ($DryRun) { Write-Host '[DRY RUN — no issues will be created]' -ForegroundColor Yellow }
Write-Host ''

# ── Process each issue ───────────────────────────────────────────────────────
$succeeded = 0
$failed    = 0
$tempFile  = $null

try {
    $tempFile = Join-Path $env:TEMP "devmate-issue-body-$([System.IO.Path]::GetRandomFileName()).md"

    for ($i = 0; $i -lt $issues.Count; $i++) {
        $issue = $issues[$i]
        $num   = $i + 1

        if (-not $issue.title) {
            Write-Warning "Issue #$num has no title — skipping."
            $failed++
            continue
        }
        if ($null -eq $issue.body) {
            Write-Warning "Issue #$num ('$($issue.title)') has no body — skipping."
            $failed++
            continue
        }

        Write-Host "[$num/$($issues.Count)] $($issue.title)"

        if ($DryRun) {
            Write-Host '  → DRY RUN: would call gh issue create' -ForegroundColor Cyan
            $succeeded++
            continue
        }

        # Write body to temp file (utf-8, no BOM)
        [System.IO.File]::WriteAllText($tempFile, $issue.body, [System.Text.UTF8Encoding]::new($false))

        $createArgs = @(
            'issue', 'create',
            '--repo',       $Repo,
            '--title',      $issue.title,
            '--body-file',  $tempFile
        )

        $output = gh @createArgs 2>&1
        if ($LASTEXITCODE -ne 0) {
            Write-Warning "  ✗ Failed to create issue #$num ('$($issue.title)'): $output"
            $failed++
        } else {
            Write-Host "  ✓ Created: $output" -ForegroundColor Green
            $succeeded++
        }
    }
} finally {
    if ($tempFile -and (Test-Path $tempFile)) {
        Remove-Item -Force $tempFile
    }
}

# ── Summary ──────────────────────────────────────────────────────────────────
Write-Host ''
Write-Host "Done. Succeeded: $succeeded  Failed: $failed  Total: $($issues.Count)"
if ($failed -gt 0) { exit 1 }
