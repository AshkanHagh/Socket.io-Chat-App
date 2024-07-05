import type { TPostAssignments, TErrorHandler, TUserProfile, TPostWithRelations, TInferSelectPostLike, TLikesArray, TInferSelectPost, TInferSelectUserNoPass, TUserId, TFollowersPostRelations, TFollowingsPost, TInferSelectTag, TModifiedFollowingsPost } from '../types/types';
import { scanTheCache, scanPostCache } from '../database/cache/post.cache';
import { getAllFromHashCache, getListScore } from '../database/cache/index.cache'
import { findFirstLike, findFirstPostWithPostId, findFirstPostWithUserId, findManyPostByUserId, findSuggestedPosts, insertPost, 
    updatePost } from '../database/queries/post.query';
import { countUserTable, findLimitedUsers, findManyFollowingPost } from '../database/queries/user.query';
import { ForbiddenError, ResourceNotFoundError } from '../libs/utils';
import ErrorHandler from '../libs/utils/errorHandler';
import { v2 as cloudinary, type UploadApiResponse } from 'cloudinary';
import shuffleArray from '../libs/utils/shuffleArray';
import { postEventEmitter } from '../events/post.event';
import { getMultipleFromHashCache } from '../database/cache/index.cache';

const combinePostCreator = (post : TInferSelectPost, user : TInferSelectUserNoPass, resultFor : 'return' | 'redis') => {
    const creator = Object.fromEntries(Object.entries(user).filter(([key, value]) => value !== null && key !== 'updatedAt'));
    const { id, text, image, createdAt, updatedAt } = post;

    if(resultFor === 'redis') return {id, text, image, userId : JSON.stringify(creator), createdAt, updatedAt};
    return {id, text, image, userId : {...creator}, createdAt, updatedAt}
}

export const calculateNumberOfSuggestions = async (creatorId : string, postId : string, returnType : 'cerate' | 'other') : Promise<number> => {
    const totalUsers : number = await countUserTable();
    const percentage : number = 0.01;
    const numberOfSuggestions : number = Math.ceil(totalUsers * percentage);

    if(returnType == 'other') {
        const score : string[] = await getListScore(`suggest_post:${creatorId}`);
        if(score.indexOf(postId) == -1) return numberOfSuggestions;

        const suggestionNumber : Array<{postId : string, suggestCount : number}> = 
        Object.entries(arrayToKeyValuePairs(score)).map(([postId, suggestCount]) => ({postId, suggestCount : +suggestCount}));

        const suggestionPost : Array<{postId : string, suggestCount : number}> = suggestionNumber.filter(post => post.postId == postId) as 
        Array<{postId : string, suggestCount : number}>

        const suggestionLimit : number = suggestionPost[0].suggestCount;
        const suggestionCount : number = totalUsers <= suggestionLimit ? 0 : numberOfSuggestions;
        return suggestionCount;
    }
    return numberOfSuggestions;
}

export const createPostService = async (currentUser : TInferSelectUserNoPass, text : string, image : string | undefined) => {
    try {
        if(image) {
            const uploadedResponse : UploadApiResponse = await cloudinary.uploader.upload(image);
            image = uploadedResponse.secure_url;
        }
        const createdPost : TInferSelectPost = await insertPost(currentUser.id, text, image);
        
        postEventEmitter.emit('create-post', currentUser.id, createdPost.id);
        postEventEmitter.emit('post_cache', createdPost.id);
        return combinePostCreator(createdPost, currentUser, 'return');
        
    } catch (err) {
        const error = err as TErrorHandler;
        throw new ErrorHandler(`An error occurred : ${error.message}`, error.statusCode);
    }
}

const fetchAndConvertCacheToObject = async (key : string) : Promise<Record<string, string>> => {
    const keysArray : string[] = await scanTheCache(key);
    const keyValuePairs : Record<string, string> = arrayToKeyValuePairs(keysArray);
    return keyValuePairs;
}

export const arrayToKeyValuePairs = (keysArray : string[]) : Record<string, string> => {
    const keyValuePairs : Record<string, string> = keysArray.reduce((accumulator, currentValue, currentIndex, array) => {
        if (currentIndex % 2 === 0) accumulator[currentValue] = array[currentIndex + 1];
        return accumulator;
    }, {} as Record<string, string>);

    return keyValuePairs;
}

const assignTrendingPostsToUsers = async (tradingPosts : TPostAssignments, users : TUserId[]) : Promise<Record<string, string[]>> => {
    const totalUsers : number = users.length;
    const postsId : string[] = Object.keys(tradingPosts);
    const userPostAssignments : Record<string, string[]> = {};

    for (const postId of postsId) {
        const userCount : number = +tradingPosts[postId]

        const shuffledUsers : TUserId[] = shuffleArray([...users]);
        const selectedUsers : Set<TUserId> = new Set<TUserProfile>();

        let i : number = 0;
        while (selectedUsers.size < userCount) {
            selectedUsers.add(shuffledUsers[i % totalUsers]);
            i++;
        }
        userPostAssignments[postId] = Array.from(selectedUsers).map(user => user.id);
    }
    return userPostAssignments;
}
// 1. Show currentUser latest post always
// 1. Each user always must have 60 post from random trending posts
export const suggestedPostsService = async (currentUserId : string) : Promise<TPostWithRelations[]> => {
    try {
        let suggestedPosts : TPostWithRelations[] = [];

        const followingPosts : TModifiedFollowingsPost[] = await getFollowingPosts(currentUserId);
        const likedPostsUsers : Record<string, string> = await fetchAndConvertCacheToObject('posts_liked:*');
        const likedPosts : TPostWithRelations[] = await assignLikedPostsToUser(likedPostsUsers);

        const currentUserPost : TPostWithRelations | undefined = await getCurrentUserLatestPost(currentUserId);
        const trendingPosts : Record<string, string> = await fetchAndConvertCacheToObject('suggest_post:*');
        // const userLimitCount = Object.entries(trendingPosts).map(([postId, quantity]) => +quantity).sort((a, b) => b - a).splice(0, 1);
        const users = await findLimitedUsers();

        const trendingPostAssignments : Record<string, string[]> = await assignTrendingPostsToUsers(trendingPosts, users);
        const postsForCurrentUser : string[] = Object.keys(trendingPostAssignments).filter(postId => 
            trendingPostAssignments[postId].includes(currentUserId)
        ).splice(0, 150);

        if(postsForCurrentUser.length !== 0) {
            const suggestedPostsCache : TPostWithRelations[] = await getMultipleFromHashCache('post', postsForCurrentUser);
            suggestedPosts = parsedPostsArray(suggestedPostsCache) as TPostWithRelations[];
            if(suggestedPostsCache.length == 0) suggestedPosts = parsedPostsArray(await findSuggestedPosts(postsForCurrentUser)) as 
            TPostWithRelations[];
        }

        const combinedPosts : TPostWithRelations[] = await mergeLikedAndTrendingPosts(likedPosts, suggestedPosts, currentUserPost, followingPosts);
        return combinedPosts;
        
    } catch (err) {
        const error = err as TErrorHandler;
        throw new ErrorHandler(`An error occurred : ${error.message}`, error.statusCode);
    }
}

export const postLikeService = async (currentUserId : string, postId : string) => {
    try {
        const postDetails : TPostWithRelations = await findFirstPostWithPostId(postId);
        if(!postDetails) throw new ResourceNotFoundError();

        const hasLiked : TInferSelectPostLike | undefined = await findFirstLike(currentUserId, postId);
        if(!hasLiked) {
            postEventEmitter.emit('like-post', currentUserId, postDetails.userId, postId);
            return 'Post has been liked';
        }

        postEventEmitter.emit('dislike-post', currentUserId, postDetails.userId, postId);
        return 'Post has been disliked';
        
    } catch (err) {
        const error = err as TErrorHandler;
        throw new ErrorHandler(`An error occurred : ${error.message}`, error.statusCode);
    }
}

const assignLikedPostsToUser = async (usersId : TPostAssignments) : Promise<TPostWithRelations[]> => {
    const matchedPosts : TPostWithRelations[] = [];

    const usersArray : TLikesArray[] = Object.entries(usersId).map(([userId, likedCount]) => ({userId, likedCount : +likedCount}));
    usersArray.sort((a, b) => b.likedCount - a.likedCount);

    for (const { userId } of usersArray) {
        const cachedPosts : TPostWithRelations[] = await scanPostCache(userId);
        
        const postPromise : Promise<TPostWithRelations[]>[] = cachedPosts.map(async post => {
            if (post.userId === userId) {
                return parsedPostsArray(cachedPosts) as TPostWithRelations[];
            } else {
                return parsedPostsArray(await findManyPostByUserId(userId)) as TPostWithRelations[];
            }
        });
        const postsArrays : TPostWithRelations[][] = await Promise.all(postPromise);
        postsArrays.forEach(posts => matchedPosts.push(...posts.splice(0, 150)));
    }

    if(matchedPosts.length <= 0) return [];
    return matchedPosts as TPostWithRelations[];
}

const mergeLikedAndTrendingPosts = async (likedPosts : TPostWithRelations[], trendingPosts : TPostWithRelations[], 
    currentUserPost : TPostWithRelations | undefined, followingPosts : TModifiedFollowingsPost[]) : Promise<TPostWithRelations[]> => {

    const postMap = new Map<string, TPostWithRelations>();
    const userPost = currentUserPost ? [currentUserPost][0] : undefined;

    [...likedPosts.splice(0, 150), ...trendingPosts.splice(0, 150), userPost, ...followingPosts].forEach(post => {
        if(post) postMap.set(post.id, post as TPostWithRelations)
    });

    const mergedPostsArray : TPostWithRelations[] = Array.from(postMap.values());
    return mergedPostsArray;
}

const parsedPostsArray = (postsArray: (TPostWithRelations[] | TFollowingsPost[])): TPostWithRelations[] | TFollowingsPost[] => {
    const matchedPosts: TPostWithRelations[] = [];

    for (const post of postsArray) {
        const { id, text, image, userId, createdAt, updatedAt, user, comments, likes, tags } = post;

        const fixedResult : TPostWithRelations = {
            id, text, image, userId, createdAt, updatedAt, user : typeof user === 'string' ? JSON.parse(user) : user, 
            comments : comments ? (typeof comments === 'string' ? JSON.parse(comments).length : comments) : [], 
            likes : likes ? (typeof likes === 'string' ? JSON.parse(likes).length : likes.length) : [], 
            tags : tags as TInferSelectTag || ''
        };
        matchedPosts.push(fixedResult);
    }
    return matchedPosts;
};

const getCurrentUserLatestPost = async (currentUserId : string) : Promise<TPostWithRelations | undefined> => {
    const currentUserPost : TPostWithRelations = await findFirstPostWithUserId(currentUserId);
    if(!currentUserPost) return undefined;

    const { id, text, image, userId, createdAt, updatedAt, user, comments, likes, tags } = currentUserPost;
    return {
        id, text, image, userId, createdAt, updatedAt, user : typeof user === 'string' ? JSON.parse(user) : user, 
        comments : comments ? (typeof comments === 'string' ? JSON.parse(comments).length : 0) : 0, 
        likes : likes ? (typeof likes === 'string' ? JSON.parse(likes).length : 0) : 0, 
        tags : tags as TInferSelectTag || ''
    }
}

const fixedResult = (posts : TFollowingsPost[]) : TModifiedFollowingsPost[] => {
    return posts.map(post => {
        const { id, text, image, userId, createdAt, updatedAt, user, comments, likes, tags } = post;
        return {
            id, text, image, userId, createdAt, updatedAt, user, 
            comments : comments.length, likes : likes.length, tags : tags as TInferSelectTag || ''
        }
    });
}

const getFollowingPosts = async (currentUserId : string) : Promise<TModifiedFollowingsPost[]> => {
    const followingPostMap : Map<string, TFollowingsPost> = new Map<string, TFollowingsPost>();

    const followings : TFollowersPostRelations[] = await findManyFollowingPost(currentUserId, 0);
    followings.forEach(following => {
        following.follower.posts.sort((a, b) => new Date(a.createdAt!).getTime() - new Date(b.createdAt!).getTime());

        return following.follower.posts.forEach(post => {
            followingPostMap.set(post.userId, post)
        });
    })
    
    const followingPost : TFollowingsPost[] = Array.from(followingPostMap.values());
    return fixedResult(followingPost);
}

export const editPostService = async (currentUserId : string, postId : string, image : string | null, text : string) => {
    try {
        let currentPost : TPostWithRelations;

        currentPost = await getAllFromHashCache(`post:${postId}`);
        if(Object.keys(currentPost).length == 0) currentPost = await findFirstPostWithPostId(postId);
        
        if(currentPost.userId !== currentUserId) throw new ForbiddenError();
        if(image) {
            const imageName : string | undefined = currentPost.image!.split('/').pop()?.split('.')[0];
            if (imageName) await cloudinary.uploader.destroy(imageName);

            const uploadedResponse : UploadApiResponse = await cloudinary.uploader.upload(image);
			image = uploadedResponse.secure_url;
        }

        const updateValues : {image : string, text : string} = {
            image : image ? image : currentPost.image, text : text ? text : currentPost.text
        } as {image : string, text : string};

        const updatedPost : TInferSelectPost = await updatePost(postId, updateValues);
        postEventEmitter.emit('updated-post', postId);
        return updatedPost;
        
    } catch (err) {
        const error = err as TErrorHandler;
        throw new ErrorHandler(`An error occurred : ${error.message}`, error.statusCode);
    }
}

export const deletePostService = async (postId : string, currentUserId : string) => {
    try {
        let currentPost : TPostWithRelations;
        currentPost = await getAllFromHashCache(`post:${postId}`);

        if(Object.keys(currentPost).length == 0) currentPost = await findFirstPostWithPostId(postId);
        if(currentPost.userId !== currentUserId) throw new ForbiddenError();

        postEventEmitter.emit('delete-post', currentPost.userId, postId);
        return 'Post has been deleted';
        
    } catch (err) {
        const error = err as TErrorHandler;
        throw new ErrorHandler(`An error occurred : ${error.message}`, error.statusCode);
    }
}