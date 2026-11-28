const createFolderQueue = () => {
  const stacks = [];
  let nextStack = 0;
  let queuedCount = 0;

  const addRoot = () => {
    const stack = [];
    stacks.push(stack);
    return (folder) => {
      stack.push(folder);
      queuedCount += 1;
    };
  };

  const take = () => {
    for (let step = 0; step < stacks.length; step += 1) {
      const index = (nextStack + step) % stacks.length;
      if (stacks[index].length > 0) {
        nextStack = (index + 1) % stacks.length;
        queuedCount -= 1;
        return stacks[index].pop();
      }
    }
    return undefined;
  };

  const isEmpty = () => queuedCount === 0;

  return { addRoot, take, isEmpty };
};

module.exports = {
  createFolderQueue
};
