/**
 * The chatbot in the browser: the accounts panel and the chat, over the server that served it.
 */
import * as accounts from './accounts.ts'
import * as chat from './chat.ts'
import { h } from './dom.ts'

const sidebar = h('aside')
const main = h('main')
document.body.replaceChildren(h('div', { class: 'app' }, [sidebar, main]))

const conversation = chat.mount(main)
accounts.mount(sidebar, conversation.refresh)
