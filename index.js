/**
 * Host loader entry for dsh-stock-strip.
 *
 * The strip is browser-only: it polls quotes from the page and never touches
 * the host process, so this half deliberately provides no behaviour. The row
 * still has to exist in the loader tree, because the Web app mounts the
 * package's `./client` for every loaded row that declares `dsh.client`.
 */
function apply() {}

export { apply };
