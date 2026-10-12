# Outlook reply-all activation

PER-567

Outlook can render a native Reply all button with role=menuitem. The previous role=button lookup missed it, and the overflow fallback clicked an unrelated toolbar menuitem before forcibly clicking a hidden duplicate.

Select the visible native button first. If unavailable, select Reply all inside the opened menu. Click once and require a visible message-body editor before returning. No public command or output schema changes.

Validation: Chromium fixtures cover normal button, role=menuitem native button, and scoped overflow fallback with hidden duplicates and delayed composer insertion. Live Outlook on the Mac mini confirmed the role=menuitem native button opens compose on the affected thread.

Release baseline: npm 0.4.3 gitHead 8ec1940b899e94e18c5cc1db9f1ef4781916de4a was reconciled separately in PR #11. Exclude unrelated unpublished changes. ClawHub 0.4.4 SKILL.md equals this baseline; publish CLI and skill as 0.4.5 to avoid the existing skill version. Preserve the local per-548 customized runtime and apply only this fix there.
