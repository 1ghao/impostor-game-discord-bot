import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ChannelType,
} from "discord.js";
import { animeQuestions } from "./data/anime-questions.js";
import { characterQuestions } from "./data/character-questions.js";

function findMatchingQuestion(realQuestion, questionBank) {
  const realTags = new Set(realQuestion.tags);
  const pools = {
    high: [], // 3+ matching tags
    medium: [], // 2 matching tags
    low: [], // 1 matching tag
    any: [], // fallback
  };

  for (const potentialMatch of questionBank) {
    if (potentialMatch.q === realQuestion.q) {
      continue;
    }

    let score = 0;
    for (const tag of potentialMatch.tags) {
      if (realTags.has(tag)) {
        score++;
      }
    }

    function checkPositivity(tags1, tags2) {
      const hasPositive1 = tags1.includes("positive");
      const hasNegative1 = tags1.includes("negative");

      const hasPositive2 = tags2.includes("positive");
      const hasNegative2 = tags2.includes("negative");

      if ((hasPositive1 && hasNegative1) || (hasPositive2 && hasNegative2)) {
        if ((hasPositive1 && hasNegative2) || (hasNegative1 && hasPositive2)) {
          return false;
        }
      }

      return true;
    }

    if (!checkPositivity(realQuestion.tags, potentialMatch.tags)) {
      score = 0;
    }

    if (score >= 3) {
      pools.high.push(potentialMatch);
    } else if (score === 2) {
      pools.medium.push(potentialMatch);
    } else if (score === 1) {
      pools.low.push(potentialMatch);
    } else {
      pools.any.push(potentialMatch);
    }
  }

  const randFloat = Math.random();

  if (pools.high.length > 2) {
    console.log(`Found ${pools.high.length} high-compatibility matches.`);
    return pools.high[Math.floor(randFloat * pools.high.length)];
  }

  if (pools.high.length > 0) {
    console.log(
      `Found only ${pools.high.length} high-compatibility matches, appending 3 medium-compatibility matches`
    );
    const mediumPool = pools.medium;

    // Shuffle array
    for (let i = mediumPool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [mediumPool[i], mediumPool[j]] = [mediumPool[j], mediumPool[i]];
    }

    while (pools.high.length < Math.min(mediumPool.length, 4)) {
      pools.high.push(mediumPool.pop());
    }
    return pools.high[Math.floor(randFloat * pools.high.length)];
  }

  if (pools.medium.length > 0) {
    console.log(
      `No high matches. Found ${pools.medium.length} medium-compatibility matches.`
    );
    return pools.medium[Math.floor(randFloat * pools.medium.length)];
  }

  if (pools.low.length > 0) {
    console.log(
      `No medium matches. Found ${pools.low.length} low-compatibility matches.`
    );
    return pools.low[Math.floor(randFloat * pools.low.length)];
  }

  // If no questions share any tags, pick a random "other" question
  console.log("No compatible matches found. Picking any random question.");
  return pools.any[Math.floor(randFloat * pools.any.length)];
}

/**
 * Starts the first round or a new round of the game
 */
export async function startRound(game, client, activeGames, threadToGameMap) {
  try {
    game.roundNumber++;
    game.state = "answering";
    // Clear data from previous rounds
    game.answers.clear();
    game.votes.clear();
    if (game.answerTimeout) clearTimeout(game.answerTimeout);
    if (game.voteTimeout) clearTimeout(game.voteTimeout);

    // Thread Clean up
    if (game.activeThreads.size > 0) {
      console.log(
        `Cleaning up ${game.activeThreads.size} threads from previous round.`
      );
      for (const threadId of game.activeThreads.values()) {
        threadToGameMap.delete(threadId);
        try {
          const thread = await client.channels.fetch(threadId);
          await thread.delete("Game round ended.");
        } catch (e) {
          console.error(
            `Failed to delete old thread (${threadId}):`,
            e.message
          );
        }
      }
      game.activeThreads.clear();
    }

    // 1. Pick correct question bank based on game.category
    let questionBank;
    let chosenCategory = game.category;

    if (chosenCategory === "random") {
      const categories = ["anime", "characters"];
      chosenCategory =
        categories[Math.floor(Math.random() * categories.length)];
    }

    if (chosenCategory === "anime") {
      questionBank = animeQuestions;
    } else {
      questionBank = characterQuestions;
    }

    if (!questionBank || questionBank.length < 2) {
      console.error("Not enough questions in the selected bank!");
      const channel = await client.channels.fetch(game.channelId);
      await channel.send(
        "Error: The selected question bank doesn't have enough questions (requires at least 2). Stopping game."
      );
      activeGames.delete(game.channelId);
      return;
    }

    // Pick real question
    const realQuestionObject =
      questionBank[Math.floor(Math.random() * questionBank.length)];

    // Pick impostor question
    const impostorQuestionObject = findMatchingQuestion(
      realQuestionObject,
      questionBank
    );

    game.realQuestion = realQuestionObject.q;
    game.impostorQuestion = impostorQuestionObject.q;

    // 3. Pick impostor
    const participantsArray = Array.from(game.participants.keys());
    game.impostorId =
      participantsArray[Math.floor(Math.random() * participantsArray.length)];

    console.log(
      `New round started in ${game.channelId}. Impostor is ${game.impostorId}`
    );

    // 4. Edit lobby message
    await game.lobbyMessage.edit({
      content:
        "The game has started! I am creating private threads for your questions... 📩",
      embeds: [],
      components: [],
    });

    // 5. Create private threads for all participants
    const failedParticipants = [];
    const channel = await client.channels.fetch(game.channelId);

    for (const [userId, user] of game.participants) {
      const isImpostor = userId === game.impostorId;
      const question = isImpostor ? game.impostorQuestion : game.realQuestion;

      try {
        const thread = await channel.threads.create({
          name: `${user.username}'s Question - Round ${game.roundNumber}`,
          type: ChannelType.PrivateThread,
          reason: `Impostor game round ${game.roundNumber}`,
        });

        await thread.members.add(user.id);

        const embed = new EmbedBuilder()
          .setTitle("Your Question Is...")
          .setDescription(`**${question}**`)
          .setFooter({ text: "Click the button below to submit your answer." });

        const button = new ButtonBuilder()
          .setCustomId(`submitAnswerButton_${game.roundNumber}`)
          .setLabel("Submit Your Answer")
          .setStyle(ButtonStyle.Primary);

        const row = new ActionRowBuilder().addComponents(button);

        await thread.send({
          content: `Welcome ${user.toString()}! Here is your secret question.`,
          embeds: [embed],
          components: [row],
        });

        threadToGameMap.set(thread.id, game.channelId);

        game.activeThreads.set(user.id, thread.id);
      } catch (error) {
        console.error(`Failed to create thread for user ${user.id}:`, error);
        failedParticipants.push(user);
      }
    }

    // 6. Handle any DM failures
    if (failedParticipants.length > 0) {
      const mentions = failedParticipants.map((u) => u.toString()).join(", ");
      await channel.send({
        content: `**Warning!** I could not create a private thread for ${mentions}.
This is usually because I am missing the **'Create Private Threads'** or **'Manage Threads'** permission in this channel.
\n**Removing the player(s) above from this round.**`,
        allowedMentions: { users: failedParticipants.map((u) => u.id) },
      });

      for (const user of failedParticipants) {
        game.participants.delete(user.id);
      }
    }

    // 7. Check if enough players are left
    if (game.participants.size < 1) {
      await channel.send(
        "There are not enough players left to continue after the DM failures. Stopping the game."
      );
      for (const threadId of game.activeThreads.values()) {
        threadToGameMap.delete(threadId);
        (await client.channels.fetch(threadId)).delete();
      }
      activeGames.delete(game.channelId);
      return;
    }

    // 8. Start answer timeout (5 minutes)
    game.answerTimeout = setTimeout(() => {
      const currentGame = activeGames.get(game.channelId);
      if (currentGame && currentGame.state === "answering") {
        console.log(`Game ${game.channelId}: Answer timeout reached.`);
        proceedToVoting(currentGame, client, activeGames, threadToGameMap);
      }
    }, 300_000);
  } catch (error) {
    console.error("Error starting round:", error);
    try {
      const channel = await client.channels.fetch(game.channelId);
      await channel.send(
        "An unknown error occurred while starting the round. Stopping the game."
      );
    } catch (e) {
      console.error("Failed to send error message to channel", e);
    }
    activeGames.delete(game.channelId);
  }
}

/**
 * Moves the game to the voting phase
 */
export async function proceedToVoting(
  game,
  client,
  activeGames,
  threadToGameMap
) {
  if (game.state !== "answering") return; // Avoid race condition
  game.state = "voting";
  clearTimeout(game.answerTimeout);

  try {
    const channel = await client.channels.fetch(game.channelId);
    let answerList = "";

    // Create a shuffled list of participants for display
    const shuffledParticipants = Array.from(game.participants.values()).sort(
      () => Math.random() - 0.5
    );

    for (const user of shuffledParticipants) {
      const answer = game.answers.get(user.id);
      answerList += `**${user.username}**: ${answer || "*No Answer Submitted*"}\n`;
    }

    const embed = new EmbedBuilder()
      .setColor(0xffff00)
      .setTitle("Time to Vote!")
      .setDescription(
        `The real question was:\n**${game.realQuestion}**\n\nHere are the answers:\n${answerList}`
      )
      .setFooter({
        text: "Discuss! Then, vote using the dropdown menu below.",
      });

    await channel.send({ embeds: [embed] });

    // Build Select Menu
    const options = Array.from(game.participants.values()).map((user) => ({
      label: user.username,
      value: user.id,
      description: `Vote for ${user.username}`,
    }));

    const menu = new StringSelectMenuBuilder()
      .setCustomId("voteMenu_" + game.roundNumber)
      .setPlaceholder("Vote for the Impostor")
      .setOptions(options);

    const row = new ActionRowBuilder().addComponents(menu);
    await channel.send({
      content: "Who is the Impostor? 🗳️",
      components: [row],
    });

    // 3. Start voting timeout (3 minutes)
    game.voteTimeout = setTimeout(() => {
      const currentGame = activeGames.get(game.channelId);
      if (currentGame && currentGame.state === "voting") {
        console.log(`Game ${game.channelId}: Voting timeout reached.`);
        proceedToReveal(currentGame, client, activeGames, threadToGameMap);
      }
    }, 900_000); // 180,000ms = 3 minutes
  } catch (error) {
    console.error("Error proceeding to voting:", error);
    // Handle error, maybe stop game
  }
}

/**
 * Reveals the game results
 */
export async function proceedToReveal(
  game,
  client,
  activeGames,
  threadToGameMap
) {
  if (game.state !== "voting") return; // Avoid race condition
  game.state = "finished";
  clearTimeout(game.voteTimeout);

  try {
    const channel = await client.channels.fetch(game.channelId);

    // 1. Tally votes
    const voteCounts = new Map();
    for (const votedId of game.votes.values()) {
      voteCounts.set(votedId, (voteCounts.get(votedId) || 0) + 1);
    }

    let result = "Vote Results:\n";
    let maxVotes = 0;
    let mostVotedIds = [];

    for (const [userId, user] of game.participants) {
      const count = voteCounts.get(userId) || 0;
      result += `**${user.username}**: ${count} vote(s)\n`;
      if (count > maxVotes) {
        maxVotes = count;
        mostVotedIds = [user.username];
      } else if (count === maxVotes && maxVotes > 0) {
        mostVotedIds.push(user.username);
      }
    }

    // 2. Build result message
    const impostor = game.participants.get(game.impostorId);
    const mostVotedPerson = mostVotedIds.join(", ");
    const impostorVictory = !(mostVotedPerson == impostor.username);

    if (mostVotedIds.length === 0) {
      result += "\nNo votes were cast!\n";
    } else {
      result += `\nThe person (or people) with the most votes was: **${mostVotedPerson}**\n`;
    }
    result += `\n**IMPOSTOR ${impostorVictory ? "WON" : "LOST"}**`;
    result += `\nThe *real* impostor was... **${impostor.username}**! 🔪\n\n`;
    result += `Their question was: **${game.impostorQuestion}**`;

    const embed = new EmbedBuilder()
      .setTitle("Game Over! Here are the results:")
      .setDescription(result)
      .setColor(impostorVictory ? 0xff0000 : 0x00ff00); // Red if yes, green if not

    // 3. Add 'Play Again' buttons
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("playAgainButton")
        .setLabel("Play Again (Same Players)")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId("endGameButton")
        .setLabel("End Game")
        .setStyle(ButtonStyle.Danger)
    );

    await channel.send({ embeds: [embed], components: [row] });
  } catch (error) {
    console.error("Error proceeding to reveal:", error);
  }
}
