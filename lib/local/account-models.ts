// local: pi-codex-claude aliases are implementation providers, while cxc-* providers
// are the public models shown in Pi's default /model view.
const ACCOUNT_PROVIDER = /^(codex|claude)-/;
const PUBLIC_PROVIDER = /^(cxc)-(codex|claude)$/;

export type AccountFamily = "codex" | "claude";

export function accountFamily(provider: string | undefined): AccountFamily | undefined {
  if (!provider) return undefined;
  const alias = provider.match(ACCOUNT_PROVIDER);
  if (alias) return alias[1] as AccountFamily;
  const publicMatch = provider.match(PUBLIC_PROVIDER);
  return publicMatch?.[2] as AccountFamily | undefined;
}

export function isAccountProvider(provider: string | undefined): boolean {
  return !!provider && ACCOUNT_PROVIDER.test(provider);
}

export function isPublicAccountProvider(provider: string | undefined): boolean {
  return !!provider && PUBLIC_PROVIDER.test(provider);
}

export function accountButtonLabel(provider: string | undefined): string {
  if (isAccountProvider(provider)) return provider!;
  const family = accountFamily(provider);
  return family ? family === "claude" ? "Claude" : "Codex" : "Account";
}

export function filterAccountModels<T extends { provider: string }>(options: T[], currentProvider: string | undefined): T[] {
  return options.filter((option) => !isAccountProvider(option.provider) || option.provider === currentProvider);
}
