# Requires PowerShell 7 (Test-Json). Validates materials, not application integration.
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$checkCodes = @('PRODUCT_IDENTITY','SKU_MATCH','PRODUCT_COLOR','PACKAGE_TEXT','INCLUDED_ITEMS','BRAND_LAYOUT','COMPOSITION','COMPOSITE_QUALITY')

function Assert-That([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

function Test-Review($Request, $Report) {
    Assert-That ($Request.context_hash -ceq $Report.context_hash) 'Review context mismatch'
    Assert-That ($Request.artifact_version_id -ceq $Report.artifact_version_id) 'Review version mismatch'
    Assert-That ($Request.artifact_hash -ceq $Report.artifact_hash) 'Review artifact mismatch'
    $actualCodes = @($Report.checks | ForEach-Object { $_.code })
    Assert-That ($actualCodes.Count -eq 8 -and @($actualCodes | Sort-Object -Unique).Count -eq 8) 'Review duplicate or missing checks'
    foreach ($code in $checkCodes) { Assert-That ($actualCodes -contains $code) "Missing $code" }
    $referenceIds = @($Request.image_bindings | Where-Object { $_.attached -and $_.role -ne 'candidate' } | ForEach-Object { $_.image_id })
    foreach ($check in $Report.checks) {
        foreach ($id in $check.reference_image_ids) { Assert-That ($referenceIds -contains $id) 'Unknown reference image' }
        if ($null -ne $check.region) {
            Assert-That ($check.region[0] -lt $check.region[2] -and $check.region[1] -lt $check.region[3]) 'Reversed region'
        }
        if ($check.status -in @('fail','unknown')) { Assert-That (-not [string]::IsNullOrWhiteSpace($check.suggested_fix)) 'Missing fix or evidence request' }
        if ($Report.observation_status -eq 'unavailable') { Assert-That ($check.status -eq 'unknown') 'Unavailable image cannot be judged' }
    }
    if ($Report.observation_status -ne 'complete' -or @($Report.checks | Where-Object { $_.status -eq 'unknown' }).Count -gt 0) {
        Assert-That ($Report.unknown_reasons.Count -gt 0) 'Missing unknown reasons'
    }
}

function Test-Plan($Request, $Plan) {
    Assert-That ($Request.context_hash -ceq $Plan.context_hash) 'Plan context mismatch'
    Assert-That ($Request.source_version_id -ceq $Plan.source_version_id) 'Plan version mismatch'
    Assert-That ($Request.based_on_report_id -ceq $Plan.based_on_report_id) 'Plan report mismatch'
    if ($Plan.decision -eq 'propose_action') {
        Assert-That $Request.report_valid 'Stale report cannot execute'
        Assert-That ($Request.limits.remaining_rounds -gt 0 -and $Request.limits.budget_remaining -ge $Request.limits.minimum_action_cost -and -not $Request.limits.deadline_reached) 'Action exceeds limits'
        $tools = @($Request.available_actions | Where-Object { $_.action -eq $Plan.action })
        Assert-That ($tools.Count -eq 1) 'Unavailable action'
        foreach ($code in $Plan.target_check_codes) {
            $issues = @($Request.issue_catalog | Where-Object { $_.code -eq $code })
            Assert-That ($issues.Count -eq 1 -and $issues[0].status -eq 'fail' -and $issues[0].allowed_actions -contains $Plan.action) 'Action not allowed for target'
        }
        $parameterJson = ConvertTo-Json -InputObject $Plan.parameters -Depth 30 -Compress
        $parameterSchema = ConvertTo-Json -InputObject $tools[0].parameter_schema -Depth 30 -Compress
        Assert-That (Test-Json -Json $parameterJson -Schema $parameterSchema -ErrorAction SilentlyContinue) 'Invalid action parameters'
    } else {
        Assert-That ($null -eq $Plan.action -and $null -eq $Plan.instruction -and $Plan.target_check_codes.Count -eq 0 -and @($Plan.parameters.PSObject.Properties).Count -eq 0) 'Non-action branch contains executable data'
    }
    if (-not $Request.report_valid) { Assert-That ($Plan.decision -eq 'needs_review') 'Stale report requires review' }
    if ($Plan.decision -eq 'no_change') {
        Assert-That (@($Request.issue_catalog | Where-Object { $_.required -and $_.status -in @('fail','unknown') }).Count -eq 0) 'Unresolved required issues'
    }
}

function Assert-Rejected([scriptblock]$Operation, [string]$Name) {
    $rejected = $false
    try { & $Operation } catch { $rejected = $true }
    Assert-That $rejected "Negative case incorrectly accepted: $Name"
}

$exampleSets = @{}
$validated = 0
foreach ($name in @('commerce-image-reviewer','commerce-image-refiner')) {
    $skillRoot = Join-Path $projectRoot "skills/$name"
    $skillText = Get-Content -LiteralPath (Join-Path $skillRoot 'SKILL.md') -Raw -Encoding utf8
    Assert-That ($skillText -match "(?s)^---\r?\nname: $name\r?\ndescription: [^\r\n]+\r?\n---") "Invalid skill frontmatter: $name"
    foreach ($reference in @('references/output.schema.json','references/examples.json')) {
        Assert-That (Test-Path -LiteralPath (Join-Path $skillRoot $reference)) "Missing reference: $reference"
    }
    $schemaPath = Join-Path $skillRoot 'references/output.schema.json'
    $examples = Get-Content -LiteralPath (Join-Path $skillRoot 'references/examples.json') -Raw -Encoding utf8 | ConvertFrom-Json
    Assert-That $examples.synthetic 'Examples must disclose synthetic origin'
    $exampleSets[$name] = $examples
    foreach ($case in $examples.cases) {
        $json = ConvertTo-Json -InputObject $case.output -Depth 40 -Compress
        Assert-That (Test-Json -Json $json -SchemaFile $schemaPath -ErrorAction SilentlyContinue) "Schema rejected $($case.id)"
        if ($name -eq 'commerce-image-reviewer') { Test-Review $case.input $case.output } else { Test-Plan $case.input $case.output }
        $validated += 1
    }
}

# Mutate fresh copies: prove checks reject malformed and unsafe protocol examples.
$review = $exampleSets['commerce-image-reviewer'].cases[0] | ConvertTo-Json -Depth 40 | ConvertFrom-Json
$review.output.checks[0].code = $review.output.checks[1].code
Assert-Rejected { Test-Review $review.input $review.output } 'duplicate checks'
$review = $exampleSets['commerce-image-reviewer'].cases[0] | ConvertTo-Json -Depth 40 | ConvertFrom-Json
$review.output.artifact_hash = 'wrong'
Assert-Rejected { Test-Review $review.input $review.output } 'wrong artifact hash'
$review = $exampleSets['commerce-image-reviewer'].cases[0] | ConvertTo-Json -Depth 40 | ConvertFrom-Json
$review.output.checks[0].region = @(0.8,0.2,0.1,0.5)
Assert-Rejected { Test-Review $review.input $review.output } 'reversed coordinates'
$plan = $exampleSets['commerce-image-refiner'].cases[0] | ConvertTo-Json -Depth 40 | ConvertFrom-Json
$plan.output.action = 'masked_edit'
Assert-Rejected { Test-Plan $plan.input $plan.output } 'unsupported tool'
$plan = $exampleSets['commerce-image-refiner'].cases[0] | ConvertTo-Json -Depth 40 | ConvertFrom-Json
$plan.input.report_valid = $false
Assert-Rejected { Test-Plan $plan.input $plan.output } 'stale action'
$plan = $exampleSets['commerce-image-refiner'].cases[0] | ConvertTo-Json -Depth 40 | ConvertFrom-Json
$plan.output.parameters.subject_asset_id = 'unauthorized_asset'
Assert-Rejected { Test-Plan $plan.input $plan.output } 'unauthorized parameter'
$schemaPath = Join-Path $projectRoot 'skills/commerce-image-refiner/references/output.schema.json'
$plan = $exampleSets['commerce-image-refiner'].cases[1] | ConvertTo-Json -Depth 40 | ConvertFrom-Json
$plan.output.action = 'recompose_subject'
$json = ConvertTo-Json -InputObject $plan.output -Depth 40 -Compress
Assert-That (-not (Test-Json -Json $json -SchemaFile $schemaPath -ErrorAction SilentlyContinue)) 'Schema accepted action on non-action branch'
Write-Output "Validated $validated synthetic output examples, 7 rejection cases, and 2 skill entrypoints. No model calls or application integration tested."
