import { useEffect, useState } from "react";
import type { Project } from "../../shared/types.ts";
import { api, type Share } from "../api.ts";
import { useDismiss } from "../useDismiss.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { Modal } from "./Modal.tsx";

interface Props {
    project: Project;
    onClose: () => void;
}

/** The project's share link: on/off, copy, rotate, and the daily limit on what visitors can add. */
export function ShareModal({ project, onClose }: Props) {
    const [closing, dismiss] = useDismiss(onClose);
    const [share, setShare] = useState<Share | null>(null);
    const [limit, setLimit] = useState("");
    const [copied, setCopied] = useState(false);
    const [rotating, setRotating] = useState(false);
    const [error, setError] = useState("");

    const apply = (next: Share) => {
        setShare(next);
        setLimit(String(next.limit));
    };

    useEffect(() => {
        api.getShare(project.id).then((r) => apply(r.share), (e: Error) => setError(e.message));
    }, [project.id]);

    /** Runs a change, shows what the server says came back, and surfaces a failure. */
    async function change(run: () => Promise<{ share: Share }>) {
        setError("");
        try {
            apply((await run()).share);
        } catch (e) {
            setError((e as Error).message);
        }
    }

    async function copy() {
        if (!share?.url) return;
        try {
            await navigator.clipboard.writeText(share.url);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        } catch {
            setError("Couldn't copy. Select the link and copy it by hand.");
        }
    }

    const commitLimit = () => {
        const n = Number(limit);
        if (!share || n === share.limit) return;
        if (!Number.isInteger(n) || n < 1 || n > 500) {
            setLimit(String(share.limit));
            setError("The limit is a whole number from 1 to 500.");
            return;
        }
        void change(() => api.setShareLimit(project.id, n));
    };

    return (
        <>
            <Modal label={`Share ${project.name}`} className="share-modal" closing={closing} onClose={dismiss} closeOnEscape={!rotating}>
                <h2 className="share-title">Share “{project.name}”</h2>
                <p className="modal-note share-lead">
                    Anyone with the link can see open tasks, add tasks and tick them off. No sign-in.
                </p>

                <div className="share-sec">
                    <div className="share-head">
                        <h3>Link sharing</h3>
                        <button
                            type="button"
                            role="switch"
                            aria-checked={share?.enabled ?? false}
                            aria-label="Link sharing"
                            className="switch"
                            disabled={!share}
                            onClick={() => share && change(() => (share.enabled ? api.disableShare(project.id) : api.enableShare(project.id)))}
                        />
                    </div>
                    {share?.url && (
                        <>
                            <div className="share-link">
                                <input readOnly value={share.url} aria-label="Share link" onFocus={(e) => e.currentTarget.select()} />
                                <button type="button" className="btn btn-primary" onClick={copy}>
                                    {copied ? "Copied" : "Copy"}
                                </button>
                            </div>
                            <div className="share-row">
                                <button type="button" className="btn btn-quiet btn-quiet-danger" onClick={() => setRotating(true)}>
                                    Rotate link…
                                </button>
                                <span className="modal-note">The old link stops working at once.</span>
                            </div>
                        </>
                    )}
                </div>

                {share?.enabled && (
                    <div className="share-sec">
                        <h3>Limit</h3>
                        <label className="share-cap">
                            Up to
                            <input
                                type="number"
                                min={1}
                                max={500}
                                value={limit}
                                onChange={(e) => setLimit(e.target.value)}
                                onBlur={commitLimit}
                                onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
                            />
                            tasks a day through this link
                        </label>
                        <p className="modal-note">
                            {share.usedToday} of {share.limit} used today.
                        </p>
                    </div>
                )}

                <p className="modal-note">Tasks added through the link are tagged “via link” in the project.</p>
                {error && <p className="modal-error">{error}</p>}
                <div className="modal-actions">
                    <button type="button" className="btn btn-quiet" onClick={dismiss}>
                        Done
                    </button>
                </div>
            </Modal>

            {rotating && (
                <ConfirmDialog
                    title="Rotate this link?"
                    message="Anyone using the current link will see “This link is no longer active”. You'll get a new link to share."
                    confirmLabel="Rotate"
                    onCancel={() => setRotating(false)}
                    onConfirm={() => {
                        setRotating(false);
                        void change(() => api.rotateShare(project.id));
                    }}
                />
            )}
        </>
    );
}
