# Vendor Terms and Unsupported Workflows

This page records the compliance posture for integrations used by `easyeda-mcp-pro`. It is an engineering checklist, not legal advice. Maintainers should review the linked vendor pages before v1.0 and before any feature that expands API use, ordering, extension distribution, or redistribution of vendor data.

## Source links reviewed

| Vendor / service      | Source to review                                                | Why it matters                                                                                                                                                         |
| --------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| EasyEDA               | https://easyeda.com/page/legal                                  | Governs use of EasyEDA services, accounts, user content, third-party services, limitations of liability, and related rights.                                           |
| JLCPCB                | https://jlcpcb.com/terms                                        | Governs JLCPCB manufacturing/order workflows when users move from review/quote preparation to actual purchase.                                                         |
| LCSC                  | https://www.lcsc.com                                            | Governs LCSC catalog, account, purchasing, and data use. If using a public/unofficial mirror such as `jlcsearch.tscircuit.com`, also review its terms and attribution. |
| jlcsearch / tscircuit | https://jlcsearch.tscircuit.com/                                | Used as a public JLCPCB in-stock parts engine; its page states it is unofficial and operated by tscircuit, not JLCPCB.                                                 |
| Mouser                | https://www.mouser.com/api-hub/ and Mouser Terms and Conditions | Governs Mouser product data, availability, pricing, cart, order, and order-history API use.                                                                            |
| DigiKey               | https://developer.digikey.com/                                  | Governs DigiKey developer API credentials, data access, and API usage.                                                                                                 |

## Project rules

1. The MCP server may read local EasyEDA project data only through the user's local EasyEDA Pro session and bridge extension.
2. Supplier data is advisory. Stock, price, lifecycle, and replacement information must be rechecked with the vendor before ordering or manufacturing handoff.
3. Ordering is disabled by default. Any quote/order workflow must be non-binding unless the user configures approved credentials and explicitly confirms the action.
4. The project must not redistribute vendor catalogs, pricing databases, datasheet archives, proprietary EasyEDA runtime files, or private user designs.
5. The project must not imply vendor endorsement or partnership without explicit permission.
6. Credentials must be supplied by the user through environment variables or the host secret store and must never be committed, logged, included in artifacts, or returned by MCP tools.
7. Human review remains mandatory before fabrication, assembly, paid quotes, component substitution, or ordering.

## Unsupported or restricted workflows

The following workflows are intentionally unsupported unless a future legal/product review approves them:

- Automatic paid JLCPCB/Mouser/DigiKey ordering without human confirmation.
- Scraping or bulk redistribution of vendor catalog data.
- Shipping preloaded vendor credentials or shared API keys.
- Uploading full private board geometry/netlists to supplier APIs except where the user explicitly triggers a documented export or quote workflow.
- Using vendor trademarks/logos in marketing in a way that implies endorsement.
- Circumventing EasyEDA account, extension, or workspace restrictions.

## Acceptance criteria for v1.0

- `THIRD_PARTY_NOTICES.md` exists and is linked from the README.
- Release artifacts contain no private designs, credentials, vendor API payload caches, or generated customer data.
- All supplier/order features clearly label stock/price/quote output as advisory until a human verifies it.
- The quote workflow keeps explicit human-review gates and audit evidence.
- `pnpm audit`, CodeQL, dependency review, and secret scanning are clean or have documented risk acceptance.
