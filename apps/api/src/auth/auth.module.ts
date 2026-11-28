import { Module, Global } from "@nestjs/common";
import { AuthService } from "./auth.service";
import { AuthController } from "./auth.controller";
import { TotpController } from "./totp.controller";
import { MeController } from "./me.controller";
import { SessionsService } from "./sessions.service";
import { IdentitiesService } from "./identities.service";
import { ClientIpPolicyService } from "./client-ip";

@Global()
@Module({
  providers: [AuthService, SessionsService, IdentitiesService, ClientIpPolicyService],
  controllers: [AuthController, TotpController, MeController],
  exports: [AuthService, SessionsService, ClientIpPolicyService],
})
export class AuthModule {}
