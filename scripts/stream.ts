async function* forever() {
	let i = 0;
	while (true) {
		const shouldContinue = yield i++;
		if (!shouldContinue) break;
	}
}


const gen = forever();
let result = await gen.next();
while (!result.done) {
	for await (const line of console) {
		if (line === "exit") break;
		console.log(`You said ${line}`);
	}
}


}

const prompt = "> ";

