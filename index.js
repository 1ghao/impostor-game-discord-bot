import {
  Client,
  GatewayIntentBits,
  Collection,
  Events,
  Partials,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
} from "discord.js";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// Import game logic
import {
  startRound,
  proceedToVoting,
  proceedToReveal,
} from "./impostor-manager.js";
// Import lobby helper
import { createImpostorLobbyEmbed } from "./commands/startImpostorGame.js";

dotenv.config();

// __dirname replacement for ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    // Note: Reactions are not needed for this button-based lobby
  ],
  partials: [Partials.Channel], // Required for DMs
});

// Central state manager
const activeGames = new Map();
const threadToGameMap = new Map();

// --- Command Loading ---
client.commands = new Collection();
const commandsPath = path.join(__dirname, "commands");
const commandFiles = fs
  .readdirSync(commandsPath)
  .filter((file) => file.endsWith(".js"));

for (const file of commandFiles) {
  const filePath = path.join(commandsPath, file);
  const command = (await import(filePath)).default; // Use default export
  if ("data" in command && "execute" in command) {
    client.commands.set(command.data.name, command);
  } else {
    console.warn(
      `[WARNING] The command at ${filePath} is missing a required "data" or "execute" property.`
    );
  }
}

// --- Event Handlers ---

client.once(Events.ClientReady, () => {
  console.log(`Ready! Logged in as ${client.user.tag}`);
});

// Central Interaction Handler
client.on(Events.InteractionCreate, async (interaction) => {
  // 1. Handle Slash Commands
  if (interaction.isChatInputCommand()) {
    const command = client.commands.get(interaction.commandName);
    if (!command) return;

    try {
      await command.execute(interaction, activeGames, threadToGameMap);
    } catch (error) {
      console.error(error);
      await interaction.reply({
        content: "There was an error while executing this command!",
        ephemeral: true,
      });
    }
    return;
  }

  // 2. Handle Buttons
  if (interaction.isButton()) {
    const { customId, user, channel, channelId } = interaction;
    let game;
    let mainChannelId;

    // Find game
    if (channel.isThread()) {
      mainChannelId = threadToGameMap.get(channelId);
      if (!mainChannelId) {
        return interaction.reply({
          content: "Error finding game. This thread may be invalid or expired.",
          ephemeral: true,
        });
      }
      game = activeGames.get(mainChannelId);
    } else {
      game = activeGames.get(channelId);
      mainChannelId = channelId;
    }

    if (!game) {
      return interaction.reply({
        content:
          "I couldn't find an active game for this interaction. It may have been stopped.",
        ephemeral: true,
      });
    }

    // Logic for THREAD buttons
    if (channel.isThread()) {
      if (customId.startsWith("submitAnswerButton_")) {
        const round = customId.split("_")[1];

        // Validate round
        if (!game || game.roundNumber.toString() !== round) {
          return interaction.reply({
            content:
              "This button is from a previous round and is no longer active.",
            ephemeral: true,
          });
        }
        // Validate state
        if (game.state !== "answering") {
          return interaction.reply({
            content: "It is not time to answer!",
            ephemeral: true,
          });
        }
        // Validate user
        if (!game.participants.has(user.id)) {
          return interaction.reply({
            content: "You are not part of this game.",
            ephemeral: true,
          });
        }
        // Validate submission
        if (game.answers.has(user.id)) {
          return interaction.reply({
            content: "You have already submitted an answer for this round.",
            ephemeral: true,
          });
        }

        // Show Modal
        const modal = new ModalBuilder()
          .setCustomId(`answerModal_${game.roundNumber}`)
          .setTitle("Submit Your Answer");
        const answerInput = new TextInputBuilder()
          .setCustomId("answerInput")
          .setLabel("What is your answer?")
          .setStyle(TextInputStyle.Short)
          .setRequired(true);
        modal.addComponents(new ActionRowBuilder().addComponents(answerInput));

        await interaction.showModal(modal);
        return;
      }
    }

    // === Logic for MAIN CHANNEL buttons ===
    if (!channel.isThread()) {
      // --- Lobby Buttons ---
      if (game.state === "lobby") {
        if (customId === "joinGame") {
          game.participants.set(user.id, user);
          const embed = createImpostorLobbyEmbed(
            game.participants.get(game.hostId),
            game.participants
          );
          await game.lobbyMessage.edit({ embeds: [embed] });
          return interaction.reply({
            content: "You have joined the game! 🎉",
            ephemeral: true,
          });
        }

        if (customId === "leaveGame") {
          if (user.id === game.hostId) {
            return interaction.reply({
              content: "The host cannot leave! Use /stopgame to end the game.",
              ephemeral: true,
            });
          }
          game.participants.delete(user.id);
          const embed = createImpostorLobbyEmbed(
            game.participants.get(game.hostId),
            game.participants
          );
          await game.lobbyMessage.edit({ embeds: [embed] });
          return interaction.reply({
            content: "You have left the game.",
            ephemeral: true,
          });
        }

        if (customId === "startGame") {
          // HOST CHECK
          if (user.id !== game.hostId) {
            return interaction.reply({
              content: "Only the host can start the game!",
              ephemeral: true,
            });
          }
          // PARTICIPANT CHECK
          if (game.participants.size < 1) {
            return interaction.reply({
              content: "You need at least 3 players to start!",
              ephemeral: true,
            });
          }

          await interaction.deferUpdate(); // Acknowledge the button click
          await startRound(game, client, activeGames, threadToGameMap);
          return;
        }
      }

      // --- End-of-Game Buttons ---
      if (game.state === "finished") {
        // HOST CHECK
        if (user.id !== game.hostId) {
          return interaction.reply({
            content: "Only the host can restart or end the game.",
            ephemeral: true,
          });
        }

        if (customId === "playAgainButton") {
          await interaction.update({
            content: "Starting a new round with the same players...",
            embeds: [],
            components: [],
          });
          await startRound(game, client, activeGames, threadToGameMap);
        } else if (customId === "endGameButton") {
          await interaction.update({
            content: "This game has ended. Thanks for playing!",
            embeds: [],
            components: [],
          });

          // Cleanup threads
          if (game.activeThreads) {
            for (const threadId of game.activeThreads.values()) {
              threadToGameMap.delete(threadId);
              try {
                const thread = await client.channels.fetch(threadId);
                await thread.delete("Game ended.");
              } catch (e) {
                console.error("Could not delete threads:", e);
              }
            }
          }
          activeGames.delete(channelId);
        }
        return;
      }
    }
  }

  // 3. Handle Modal Submissions
  if (interaction.isModalSubmit()) {
    if (interaction.customId.startsWith("answerModal_")) {
      const round = interaction.customId.split("_")[1];

      const mainChannelId = threadToGameMap.get(interaction.channelId);
      if (!mainChannelId) {
        return interaction.reply({
          content: "Error finding game. This modal may be invalid.",
          ephemeral: true,
        });
      }
      const game = activeGames.get(mainChannelId);

      if (!game || game.roundNumber.toString() !== round) {
        return interaction.reply({
          content:
            "This modal is from a previous round and is no longer active.",
          ephemeral: true,
        });
      }
      if (game.answers.has(interaction.user.id)) {
        return interaction.reply({
          content: "You have already submitted an answer. Please wait...",
          ephemeral: true,
        });
      }

      const answer = interaction.fields.getTextInputValue("answerInput");
      game.answers.set(interaction.user.id, answer);

      await interaction.reply({
        content:
          "Got it! Your answer has been recorded. ✅\nWaiting for other players...",
        ephemeral: true,
      });

      if (game.answers.size === game.participants.size) {
        proceedToVoting(game, client, activeGames, threadToGameMap);
      }
    }
    return;
  }

  // 4. Handle Select Menus (Voting)
  if (interaction.isStringSelectMenu()) {
    if (interaction.customId.startsWith("voteMenu_")) {
      const round = interaction.customId.split("_")[1];
      const { channelId, user } = interaction;
      const game = activeGames.get(channelId);

      if (!game || game.state !== "voting") {
        return interaction.reply({
          content: "It is not time to vote!",
          ephemeral: true,
        });
      }
      if (game.roundNumber.toString() !== round) {
        return interaction.reply({
          content:
            "This voting menu is from a previous round and is no longer active.  expired",
          ephemeral: true,
        });
      }

      if (!game.participants.has(user.id)) {
        return interaction.reply({
          content: "You are not a participant in this game.",
          ephemeral: true,
        });
      }
      if (game.votes.has(user.id)) {
        return interaction.reply({
          content: "You have already voted.",
          ephemeral: true,
        });
      }

      const votedId = interaction.values[0];
      game.votes.set(user.id, votedId);
      const votedUser = game.participants.get(votedId);

      await interaction.reply({
        content: `You have voted for **${votedUser.username}**.`,
        ephemeral: true,
      });

      // Check if all votes are in
      if (game.votes.size === game.participants.size) {
        proceedToReveal(game, client, activeGames, threadToGameMap);
      }
    }
    return;
  }
});

client.login(process.env.DISCORD_TOKEN);
