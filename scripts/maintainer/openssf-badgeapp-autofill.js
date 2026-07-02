// OpenSSF BadgeApp autofill helper for easyeda-mcp-pro project 13406.
// Usage:
// 1. Log in to https://www.bestpractices.dev/ as the project owner.
// 2. Open https://www.bestpractices.dev/en/projects/13406/passing or /silver.
// 3. Open browser DevTools Console.
// 4. Paste this script.
// 5. Review every changed field before pressing Save.
//
// This script is intentionally conservative. It only sets radio buttons and
// does not submit the form.

(() => {
  const met = [
    'homepage_url',
    'description_good',
    'interact',
    'contribution_requirements',
    'documentation_interface',
    'repo_interim',
    'version_unique',
    'version_semver',
    'version_tags',
    'release_notes_vulns',
    'report_url',
    'report_tracker',
    'report_responses',
    'enhancement_responses',
    'report_archive',
    'vulnerability_report_process',
    'vulnerability_report_private',
    'vulnerability_report_response',
    'build',
    'build_common_tools',
    'build_floss_tools',
    'test',
    'test_invocation',
    'test_most',
    'test_policy',
    'tests_are_added',
    'tests_documented_added',
    'warnings',
    'warnings_fixed',
    'warnings_strict',
    'know_secure_design',
    'know_common_errors',
    'delivery_unsigned',
    'vulnerabilities_fixed_60_days',
    'vulnerabilities_critical_fixed',
    'static_analysis',
    'static_analysis_common_vulnerabilities',
    'static_analysis_fixed',
    'static_analysis_often',
    'test_continuous_integration',
    'no_leaked_credentials',
    'english',
    'hardening',
    'crypto_used_network',
    'crypto_tls12',
    'crypto_certificate_verification',
    'crypto_verification_private',
    'hardened_site',
    'installation_common',
    'dco',
    'governance',
    'code_of_conduct',
    'roles_responsibilities',
    'access_continuity',
    'documentation_roadmap',
    'documentation_architecture',
    'documentation_security',
    'documentation_quick_start',
    'documentation_current',
    'documentation_achievements',
    'maintenance_or_update',
    'vulnerability_report_credit',
    'vulnerability_response_process',
    'coding_standards',
    'coding_standards_enforced',
    'build_non_recursive',
    'build_repeatable',
    'installation_development_quick',
    'external_dependencies',
    'dependency_monitoring',
    'updateable_reused_components',
    'interfaces_current',
    'automated_integration_testing',
    'regression_tests_added50',
    'test_statement_coverage80',
    'test_policy_mandated',
    'implement_secure_design',
    'input_validation',
    'crypto_credential_agility',
    'assurance_case',
  ];

  const na = [
    'dynamic_analysis',
    'dynamic_analysis_unsafe',
    'dynamic_analysis_enable_assertions',
    'dynamic_analysis_fixed',
    'sites_password_security',
    'build_standard_variables',
    'build_preserve_debug',
    'installation_standard_variables',
  ];

  const leaveForManualReview = [
    'achieve_passing',
    'achieve_silver',
    'bus_factor',
    'internationalization',
    'signed_releases',
    'version_tags_signed',
    'crypto_algorithm_agility',
  ];

  function setStatus(name, value) {
    const selector = `input[name="project[${name}_status]"][value="${value}"]`;
    const radio = document.querySelector(selector);
    if (!radio) return false;
    radio.disabled = false;
    radio.checked = true;
    radio.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  const changed = [];
  const missing = [];

  for (const name of met) (setStatus(name, 'Met') ? changed : missing).push(`${name}=Met`);
  for (const name of na) (setStatus(name, 'N/A') ? changed : missing).push(`${name}=N/A`);

  console.table({
    changed: changed.length,
    missing: missing.length,
    manualReview: leaveForManualReview.length,
  });
  console.log('Changed:', changed);
  console.log('Missing on this page:', missing);
  console.log('Manual review required:', leaveForManualReview);
  console.warn(
    'Review every criterion and evidence link before saving. This script does not submit the form.',
  );
})();
