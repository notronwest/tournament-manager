import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { captureCampaignParam } from "../lib/campaignCapture";

// Mount once inside the Router (App), alongside ScrollToTop — on every
// route change, persist a `?c=<campaign>` query param for the rest of the
// browser session so it survives the redirect through login / magic-link /
// OAuth and is still there when the player signs up (D-0077).
export default function CampaignCapture() {
  const { search } = useLocation();
  useEffect(() => {
    captureCampaignParam(search);
  }, [search]);
  return null;
}
