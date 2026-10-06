import { useEffect, useRef, useState } from "react";
import { api, type Preferences } from "../api.ts";

interface Props {
    onDone: (preferences: Preferences) => void;
}

/**
 * First-run step: asks for the name the sidebar greets you by. The login gives
 * none, so it's stored on the account. Can't be dismissed; it only shows while
 * no first name is saved.
 */
export function AccountSetup({ onDone }: Props) {
    const [firstName, setFirstName] = useState("");
    const [lastName, setLastName] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const firstRef = useRef<HTMLInputElement>(null);

    useEffect(() => firstRef.current?.focus(), []);

    const canSave = firstName.trim() !== "" && lastName.trim() !== "";

    async function save(e: React.FormEvent) {
        e.preventDefault();
        if (!canSave || busy) return;
        setBusy(true);
        setError(null);
        try {
            const { preferences } = await api.setPreferences({
                firstName: firstName.trim(),
                lastName: lastName.trim(),
            });
            onDone(preferences);
        } catch (err) {
            setError((err as Error).message);
            setBusy(false);
        }
    }

    return (
        <div className="modal-backdrop">
            <div className="modal setup-modal" role="dialog" aria-modal="true" aria-labelledby="setup-title">
                <form onSubmit={save}>
                    <h2 id="setup-title" className="setup-title">
                        Welcome to dash<span className="dot">.</span>
                    </h2>
                    <p className="setup-lede">What should we call you?</p>

                    <div className="modal-grid">
                        <label>
                            <span>First name</span>
                            <input
                                ref={firstRef}
                                value={firstName}
                                maxLength={50}
                                autoComplete="given-name"
                                onChange={(e) => setFirstName(e.target.value)}
                            />
                        </label>
                        <label>
                            <span>Last name</span>
                            <input
                                value={lastName}
                                maxLength={50}
                                autoComplete="family-name"
                                onChange={(e) => setLastName(e.target.value)}
                            />
                        </label>
                    </div>

                    <p className="modal-note">You can change this later in Settings.</p>
                    {error && <p className="modal-error">{error}</p>}

                    <div className="modal-actions">
                        <button type="submit" className="btn btn-primary" disabled={!canSave || busy}>
                            {busy ? "Saving…" : "Continue"}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
}
