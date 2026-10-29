// UX-3: one re-authentication prompt at a time. Requests that need the step-up while a prompt is open wait for it
// instead of opening their own (before, a second prompt cancelled the first and its action failed); a request that
// needs more than the open prompt asks for (the passkey after a password-only prompt) asks again for the rest only.
// Pure (no DOM): the frontend passes the function that shows its dialog; the backend suite tests it.

export interface StepUpNeeds {
  password: boolean;
  passkey: boolean;
}

/** Does a confirmation of `done` cover what `wanted` needs? */
export const covers = (done: StepUpNeeds, wanted: StepUpNeeds) => (done.password || !wanted.password) && (done.passkey || !wanted.passkey);

export function createStepUpGate(ask: (needs: StepUpNeeds) => Promise<boolean>) {
  let open: { needs: StepUpNeeds; result: Promise<boolean> } | null = null;
  return async function stepUp(needs: StepUpNeeds): Promise<boolean> {
    while (open) {
      const current = open;
      if (!(await current.result)) return false;
      if (covers(current.needs, needs)) return true;
      // The finished prompt did not cover this request: ask for what is still missing (password already confirmed).
      needs = { password: needs.password && !current.needs.password, passkey: needs.passkey && !current.needs.passkey };
    }
    if (!needs.password && !needs.passkey) return true;
    const result = ask(needs).finally(() => {
      if (open?.result === result) open = null;
    });
    open = { needs, result };
    return result;
  };
}
