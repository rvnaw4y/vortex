"use strict";
const stockSW = "./sw.js";
const controllerWaitMs = 4000;
let swBootPromise = null;

/**
 * List of hostnames that are allowed to run serviceworkers on http://
 */
const swAllowedHostnames = ["localhost", "127.0.0.1"];

/**
 * Global util
 * Used in 404.html and index.html
 */
async function registerSW() {
	if (swBootPromise) return swBootPromise;

	if (!navigator.serviceWorker) {
		if (
			location.protocol !== "https:" &&
			!swAllowedHostnames.includes(location.hostname)
		)
			throw new Error("Service workers cannot be registered without https.");

		throw new Error("Your browser doesn't support service workers.");
	}

	swBootPromise = (async () => {
		const registration = await navigator.serviceWorker.register(stockSW);
		await navigator.serviceWorker.ready;
		await waitForController();
		return registration;
	})();

	try {
		return await swBootPromise;
	} catch (err) {
		swBootPromise = null;
		throw err;
	}
}

async function waitForController() {
	if (navigator.serviceWorker.controller) return;

	await new Promise((resolve) => {
		let settled = false;
		const done = () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			navigator.serviceWorker.removeEventListener("controllerchange", done);
			resolve();
		};
		const timer = setTimeout(done, controllerWaitMs);
		navigator.serviceWorker.addEventListener("controllerchange", done, {
			once: true,
		});
	});
}
