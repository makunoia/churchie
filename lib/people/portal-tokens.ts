type PortalTokens = { selfServiceToken: string | null; selfServiceTokenAliases: string[] }

/** Preserve every previously issued link, including aliases from earlier merges. */
export function mergePortalTokens(keeper: PortalTokens, incoming: PortalTokens): PortalTokens {
  const selfServiceToken = keeper.selfServiceToken ?? incoming.selfServiceToken
  return {
    selfServiceToken,
    selfServiceTokenAliases: [...new Set([
      ...keeper.selfServiceTokenAliases, ...incoming.selfServiceTokenAliases,
      ...(incoming.selfServiceToken ? [incoming.selfServiceToken] : []),
    ])].filter(token => token !== selfServiceToken),
  }
}

export function portalTokenWhere(token: string) {
  return { OR: [{ selfServiceToken: token }, { selfServiceTokenAliases: { has: token } }] }
}
