import { Controller, Get, Req } from "@nestjs/common";
import { PERMISSIONS } from "@lampstand/shared";
import { RequirePermissions } from "../auth/permissions.decorator";
import { SessionOnly } from "../auth/session-only.decorator";
import { SecurityPostureService } from "./security-posture.service";

/** `GET /admin/security-posture`: the checks behind the admin Security overview. Session-only: it maps the site's weak spots. */
@Controller("admin/security-posture")
export class SecurityPostureController {
  constructor(private readonly posture: SecurityPostureService) {}

  @Get()
  @SessionOnly()
  @RequirePermissions(PERMISSIONS.SITE_ADMIN)
  get(@Req() req: { ip?: string; headers?: Record<string, string | string[] | undefined> }) {
    // The forwarded chain as it reached the API, so an admin can see which address their proxy adds (leftmost first; the
    // socket is Caddy or the web container and says nothing, so it is left out).
    const raw = req.headers?.["x-forwarded-for"];
    const chain = (Array.isArray(raw) ? raw.join(",") : (raw ?? "")).split(",").map((s) => s.trim()).filter(Boolean).slice(-20);
    return this.posture.report(new Date(), { yourAddress: req.ip ?? null, yourChain: chain });
  }
}
