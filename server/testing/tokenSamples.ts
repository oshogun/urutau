/** One synthetic value for each token prefix the log redaction recognises. */
export const TOKEN_SAMPLES: Readonly<Record<string, string>> = {
  urutau_mcp_: 'urutau_mcp_' + 'A'.repeat(43),
  github_pat_: 'github_pat_urutau_fixture_not_a_real_token',
  ghp_: 'ghp_' + 'F'.repeat(36),
  gho_: 'gho_' + 'F'.repeat(36),
  ghu_: 'ghu_' + 'F'.repeat(36),
  ghs_: 'ghs_' + 'F'.repeat(36),
  ghr_: 'ghr_' + 'F'.repeat(36),
}

/** Ordinary text that contains gh[pousr]_ followed by underscore-separated words; it must not be redacted. */
export const LOOKALIKE_TEXT: readonly string[] = [
  '/api/github/repos/acme/highs_and_lows_of_the_season/issues',
  'acme/coughs_and_sneezes_tracker_backend',
  'acme/laughs_and_cries_of_the_team',
  'acme/sighs_and_whispers_in_the_wind',
  'acme/graphs_and_charts_of_the_year',
  'acme/photos_and_videos_of_the_party',
  'acme/ghp_and_ghu_in_snake_case_words',
  'acme/gho_ghr_ghs_with_snake_case_words',
]
