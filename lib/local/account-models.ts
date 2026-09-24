// local: pi-codex-claude registers one provider per account ("codex-*",
// "claude-*"). Listing all of them floods the model picker, so keep only the
// account the session is on; switching accounts goes through AccountButton.

const ACCOUNT_PROVIDER = /^(codex|claude)-/;

export function isAccountProvider(provider: string | undefined): boolean {
  return !!provider && ACCOUNT_PROVIDER.test(provider);
}

export function filterAccountModels<T extends { provider: string }>(options: T[], currentProvider: string | undefined): T[] {
  return options.filter((option) => !isAccountProvider(option.provider) || option.provider === currentProvider);
}
