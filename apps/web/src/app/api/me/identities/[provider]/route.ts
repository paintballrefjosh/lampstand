import { forwardToApi } from "@/lib/api";

type Ctx = { params: Promise<{ provider: string }> };

// The identity to remove is named by the `id` query string, which forwardToApi passes on.
export async function DELETE(req: Request, ctx: Ctx) {
  const { provider } = await ctx.params;
  return forwardToApi(req, `/api/v1/me/identities/${encodeURIComponent(provider)}`);
}
