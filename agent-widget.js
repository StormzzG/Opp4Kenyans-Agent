class OppChatbot extends HTMLElement {
    constructor() {
        super();
        this.attachShadow({ mode: "open" });
    }

    async connectedCallback() {
        const html = await fetch("https://opp4kenyansagent.netlify.app")
            .then(res => res.text());

        const parser = new DOMParser();
        const doc = parser.parseFromString(html, "text/html");

        const bodyContent = doc.body.innerHTML;
        const cssLinks = [...doc.querySelectorAll("link[rel='stylesheet']")];
        const scripts = [...doc.querySelectorAll("script[src]")];

        const container = document.createElement("div");
        container.innerHTML = bodyContent;
        this.shadowRoot.appendChild(container);

        cssLinks.forEach(link => {
            const newLink = document.createElement("link");
            newLink.rel = "stylesheet";
            newLink.href = link.href;
            this.shadowRoot.appendChild(newLink);
        });

        for (let script of scripts) {
            const newScript = document.createElement("script");
            newScript.src = script.src;
            newScript.defer = true;
            this.shadowRoot.appendChild(newScript);
        }

        this.shadowRoot.host.style.display = "block";
        this.shadowRoot.host.style.width = "100%";
        this.shadowRoot.host.style.height = "100%";
    }
}

customElements.define("opp-chatbot", OppChatbot);
