import { useState } from "react";

import type { Comment } from "../api/comments";
import { errorKey } from "../api/errors";
import { Avatar } from "../components/Avatar";
import { Field } from "../components/Field";
import { formatShortDate, formatTime } from "../i18n/dates";
import { useLocale } from "../i18n/LocaleProvider";
import { browserTimeZone, dayIn } from "../time/zone";
import { rememberGuestName, storedGuestName } from "./guestName";

import "./comments.css";

/**
 * The reply feed and the answer form — one and the same on the working screen and on the public
 * page.
 *
 * There is exactly one difference between a member and a guest: a guest signs with a name they
 * enter themselves. Keeping two feeds for that would mean maintaining two ways of showing one
 * and the same conversation — and one day they would diverge on the very "guest" mark the whole
 * thing was for.
 */
export function CommentThread({
  comments,
  loading = false,
  error,
  askName = false,
  canComment = true,
  onSend,
  sending = false,
  sendError,
  embedded = false,
}: {
  comments: Comment[];
  loading?: boolean;
  error?: unknown;
  /** Whether to ask for a name: a guest has no account and nothing to sign with. */
  askName?: boolean;
  /** Disabled comments close the form but not the feed itself. */
  canComment?: boolean;
  /**
   * The submission. A promise, if the caller gives one: the field is cleared only after the
   * confirmation — a server refusal is a reason to correct the reply rather than to type it anew.
   */
  onSend: (input: { body: string; name: string }) => void | Promise<unknown>;
  sending?: boolean;
  sendError?: unknown;
  /**
   * The feed inside the card's panel: the heading and the rule above are given by the panel, and
   * a second "Comments" heading under "Discussion" would read as one more section.
   */
  embedded?: boolean;
}) {
  const { t, locale } = useLocale();
  // The date and the time next to each other must be counted by one clock: the time is by the
  // machine's clock (see formatTime), and the day is taken from it too rather than by truncating
  // an ISO string in UTC — otherwise a reply at one in the morning was signed with yesterday's
  // date and today's time.
  const zone = browserTimeZone();
  const [body, setBody] = useState("");
  // The name is pulled from the browser straight away: a guest who has named themselves once must
  // not enter it again under every reply.
  const [name, setName] = useState(() => (askName ? storedGuestName() : ""));

  const trimmedBody = body.trim();
  const trimmedName = name.trim();
  const ready = trimmedBody !== "" && (!askName || trimmedName !== "");

  return (
    <section
      className={embedded ? "comments comments--embedded" : "comments"}
      aria-label={t("comments.title")}
    >
      {!embedded && <h2 className="comments__title">{t("comments.title")}</h2>}

      {loading && <p role="status">{t("common.loading")}</p>}

      {error !== undefined && error !== null && (
        <p className="error" role="alert">
          {t(errorKey(error))}
        </p>
      )}

      {!loading && comments.length === 0 && <p className="muted">{t("comments.empty")}</p>}

      <ol className="comments__list">
        {comments.map((comment) => (
          <li key={comment.id} className="comment">
            {/* The avatar — as in the mockup: in a feed of a dozen replies the participants are
                told apart by a patch of colour faster than by reading names. */}
            <Avatar name={comment.author.name} size={30} />
            <div className="comment__content">
              <p className="comment__head">
                {/* The author's name is user content: it is not translated whatever the interface
                    language. */}
                <span className="comment__author">{comment.author.name}</span>
                {comment.author.guest && (
                  <span className="comment__guest">{t("comments.guest")}</span>
                )}
                {/* The date and the time: in a conversation within one day a date without a time
                    does not tell the replies apart at all. */}
                <span className="muted">
                  {formatShortDate(t, dayIn(zone, new Date(comment.created_at)))}
                  {" · "}
                  {formatTime(locale, new Date(comment.created_at))}
                </span>
              </p>
              <p className="comment__body">{comment.body}</p>
            </div>
          </li>
        ))}
      </ol>

      {canComment ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!ready) return;
            if (askName) rememberGuestName(trimmedName);
            const sent = onSend({ body: trimmedBody, name: trimmedName });
            // The refusal is shown through sendError, here it only leaves the text in place; an
            // unhandled promise rejection would surface in the console by itself at that.
            void Promise.resolve(sent).then(
              () => setBody(""),
              () => undefined,
            );
          }}
        >
          {askName && (
            <Field
              id="comment-name"
              label={t("comments.your_name")}
              value={name}
              onChange={setName}
              autoComplete="nickname"
            />
          )}

          <p className="field">
            <label htmlFor="comment-body">{t("comments.body")}</label>
            <textarea
              id="comment-body"
              name="comment-body"
              rows={3}
              value={body}
              onChange={(event) => setBody(event.target.value)}
            />
          </p>

          {sendError !== undefined && sendError !== null && (
            <p className="error" role="alert">
              {t(errorKey(sendError))}
            </p>
          )}

          <button type="submit" disabled={!ready || sending}>
            {t("comments.send")}
          </button>
        </form>
      ) : (
        // Not emptiness in the form's place: disabled comments are the owner's decision, and a
        // person must read it in words rather than guess where the input field has gone.
        <p className="muted">{t("comments.closed")}</p>
      )}
    </section>
  );
}
