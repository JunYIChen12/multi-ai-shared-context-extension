/// <reference types="chrome" />

const openButton = document.querySelector("#open");
openButton?.addEventListener("click", () => {
  void chrome.tabs.create({ url: chrome.runtime.getURL("discussion.html") });
});
