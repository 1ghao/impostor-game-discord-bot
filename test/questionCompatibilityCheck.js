import { animeQuestions } from "../data/anime-questions.js";
import { characterQuestions } from "../data/character-questions.js";
import { findMatchingQuestion } from "../game-manager.js";
import readline from "node:readline";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function compatibilityCheck() {
  const categories = ["anime", "characters"];
  let questionBank;
  const chosenCategory =
    categories[Math.floor(Math.random() * categories.length)];

  if (chosenCategory === "anime") {
    questionBank = animeQuestions;
  } else {
    questionBank = characterQuestions;
  }
  const realQuestionObject =
    questionBank[Math.floor(Math.random() * questionBank.length)];

  const impostorQuestionObject = findMatchingQuestion(
    realQuestionObject,
    questionBank
  );

  console.log("Real question: ", realQuestionObject.q);
  console.log("Impostor question: ", impostorQuestionObject.q);
}

function next() {
  rl.question("Next: ", (a) => {
    a;
    compatibilityCheck();
    next();
  });
}

next();
