import { exportAccount } from "../../lib/accountExport";
import { cancelLiveSubscriptions } from "../../lib/billing";
import { recordPrivacyRequest } from "../../lib/privacyRequests";
import { StripeNotConfiguredError } from "../../lib/stripe";
import { supabaseAdmin } from "../../lib/supabaseAdmin";
import { requireAuthStrict } from "../../middleware/auth";
import { createAccountRouter } from "./accountRouter";

export const accountRouter = createAccountRouter({
  authenticate: requireAuthStrict,
  loadUser: async (userId) => {
    const { data, error } = await supabaseAdmin.from("users").select("email, role").eq("id", userId).maybeSingle();
    if (error) throw error;
    return data;
  },
  exportAccount,
  steps: {
    cancelSubscriptions: cancelLiveSubscriptions,
    deleteAuthUser: async (userId) => {
      // Suppression réelle : la base supprime le compte et ses données personnelles en cascade, détache
      // l'historique et les pièces comptables, anonymise les pages d'artiste.
      const { error } = await supabaseAdmin.auth.admin.deleteUser(userId);
      if (error) throw error;
    },
  },
  record: recordPrivacyRequest,
  billingFailure: (err) => {
    if (err instanceof StripeNotConfiguredError) {
      return { status: 503, body: { error: "Subscriptions cannot be cancelled right now. Please try again later.", code: "billing_unavailable" } };
    }
    const { type } = (err ?? {}) as { type?: string };
    if (type?.startsWith("Stripe")) {
      return { status: 502, body: { error: "Your subscription could not be cancelled, so nothing was deleted. Please try again.", code: "billing_provider_error" } };
    }
    return null;
  },
});
